import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

import {
  startMockProvider,
  startPgTestCluster,
  type MockProviderHandle,
  type PgTestCluster,
} from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import { claimJobs, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';
import {
  markGenerationOutcomeUnknown,
  deadLetterJob,
  resolveUnknown,
  probeByRequestId,
} from '../src/reconcile.js';

/**
 * J06 acceptance: after a provider timeout/interruption the task is never
 * automatically re-sent (execute itself moves generation → outcome_unknown
 * and dead-letters the job, even when the provider demonstrably accepted the
 * request); without a provider request ID the task stays unknown; an explicit
 * disposition entry (request-ID probe or operator decision) resolves it.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let storage: import('../../api/src/infra/storage/storage.js').LocalDiskStorage;
let storageRoot = '';
let subjectId = '';
let precheckId = '';
let provider: MockProviderHandle;
let counter = 0;

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('reconcile');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  provider = await startMockProvider();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'j06-storage-'));
  storage = new (await import('../../api/src/infra/storage/storage.js')).LocalDiskStorage(storageRoot);

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j06-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;

  const promptBody = '[System / Prompt]\nj06 body\n';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j06-catalog-'));
  const fs = await import('node:fs/promises');
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-6',
        title: 'J06 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-6.txt',
        promptSha256: (await import('../../api/src/modules/catalog/import.js')).sha256Hex(
          (await import('../../api/src/modules/catalog/import.js')).stablePromptBody(promptBody),
        ),
        source: null,
      },
    ],
  };
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-6.txt'), promptBody);
  await (await import('../../api/src/modules/catalog/import.js')).importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });

  const uploads = new (await import('../../api/src/modules/media/upload-service.js')).UploadService(client, storage);
  const prechecks = new (await import('../../api/src/modules/media/precheck-service.js')).PrecheckService(client, storage);
  const created = await uploads.createUpload({ ownerId: subjectId, declaredBytes: PNG.length, declaredMime: 'image/png' });
  if (!created.ok) throw new Error('fixture failed');
  await uploads.putQuarantineBytes(created.value.uploadId, subjectId, PNG);
  const confirmed = await uploads.confirmUpload({ uploadId: created.value.uploadId, ownerId: subjectId, actualSha256: 'x' });
  if (!confirmed.ok) throw new Error('fixture failed');
  const precheck = await prechecks.createPrecheck({
    subjectId,
    templateKey: 'case-6',
    version: 1,
    mediaObjectId: confirmed.value.mediaObjectId,
    settings: { model: 'gpt-image-2', quality: 'high', aspect: 'inherit' },
  });
  if (!precheck.ok) throw new Error('fixture precheck failed');
  precheckId = precheck.value.precheckId;
});

afterAll(async () => {
  await provider?.close();
  await client?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

/** A fetch that always fails as if the connection dropped mid-request. */
const droppingFetch: typeof fetch = (async () => {
  throw new Error('network connection dropped');
}) as unknown as typeof fetch;

/**
 * A fetch that delivers the request to the (mock) provider — so the provider
 * demonstrably ACCEPTED it — and then fails as if the connection dropped
 * before the response arrived.
 */
const acceptThenDropFetch: typeof fetch = (async (input: unknown, init: unknown) => {
  await fetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
  throw new Error('connection reset after provider accepted the request');
}) as unknown as typeof fetch;

async function createGeneration(key: string): Promise<string> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: database.uri });
  try {
    const service = new (await import('../../api/src/modules/generation/create.js')).GenerationService({ pool }, 5);
    const result = await service.create({
      ownerId: subjectId,
      precheckId,
      idempotencyKey: key,
      providerId: 'direct-byok',
      model: 'gpt-image-2',
    });
    if (!result.ok) throw new Error(`generation failed: ${result.code}`);
    return result.generationId;
  } finally {
    await pool.end();
  }
}

async function adapterDeps(fetchImpl: typeof fetch): Promise<ExecutionDeps> {
  const { ProviderAdapter } = await import('../../api/src/modules/generation/provider-adapter.js');
  const adapter = new ProviderAdapter(
    {
      providerId: 'direct-byok',
      label: 'BYOK',
      baseUrl: provider.baseUrl,
      apiKey: 'sk-j06',
      models: [{ id: 'gpt-image-2', qualities: ['high'] }],
    },
    { fetchImpl },
  );
  return {
    db: client as unknown as Queryable,
    adapter,
    storage,
    providerId: 'direct-byok',
  };
}

describe('outcome_unknown + reconciliation (J06)', () => {
  it('provider accepted then connection dropped: outcome_unknown, job dead, no automatic resend', async () => {
    counter += 1;
    const generationId = await createGeneration(`j06-unknown-${counter}`);
    const [lease] = await claimJobs(client, { workerId: 'j06', kinds: ['generate'] });
    const before = provider.requests.length;

    const deps = await adapterDeps(acceptThenDropFetch);
    const outcome = await executeClaimedJob(deps, {
      jobId: lease!.jobId,
      workerId: 'j06',
      generationId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('PROVIDER_TIMEOUT_UNKNOWN');
      expect(outcome.refused).toBe(false);
    }

    // The provider demonstrably received the request (accepted → may bill).
    expect(provider.requests.length).toBe(before + 1);

    // Execute itself performed the full transition: generation → unknown.
    const generation = await client.query<{ state: string; error_code: string | null }>(
      'SELECT state, error_code FROM generation WHERE id = $1',
      [generationId],
    );
    expect(generation.rows[0]!.state).toBe('outcome_unknown');
    expect(generation.rows[0]!.error_code).toBe('PROVIDER_TIMEOUT_UNKNOWN');
    const attempt = await client.query<{ state: string; provider_request_id: string | null }>(
      'SELECT state, provider_request_id FROM attempt WHERE generation_id = $1',
      [generationId],
    );
    expect(attempt.rows[0]!.state).toBe('unknown');
    expect(attempt.rows[0]!.provider_request_id).toBeNull();

    // Job dead-lettered by the executing worker: no resend path remains.
    const job = await client.query<{ state: string; dead_reason: string | null }>(
      'SELECT state, dead_reason FROM job WHERE id = $1',
      [lease!.jobId],
    );
    expect(job.rows[0]!.state).toBe('dead');
    expect(job.rows[0]!.dead_reason).toBe('PROVIDER_TIMEOUT_UNKNOWN');
    const noClaim = await claimJobs(client, { workerId: 'other', kinds: ['generate'] });
    expect(noClaim).toHaveLength(0);

    // Re-applying the transition helpers is a CAS no-op (idempotent).
    expect(await markGenerationOutcomeUnknown(client, { generationId })).toBe(false);
    expect(await deadLetterJob(client, { jobId: lease!.jobId, workerId: 'j06', reason: 'PROVIDER_TIMEOUT_UNKNOWN' })).toBe(false);
  });

  it('stays unknown without a request ID and needs explicit disposition', async () => {
    counter += 1;
    const generationId = await createGeneration(`j06-noid-${counter}`);
    const [lease] = await claimJobs(client, { workerId: 'j06', kinds: ['generate'] });
    const deps = await adapterDeps(droppingFetch);
    await executeClaimedJob(deps, { jobId: lease!.jobId, workerId: 'j06', generationId });

    const generation = await client.query<{ state: string }>('SELECT state FROM generation WHERE id = $1', [generationId]);
    expect(generation.rows[0]!.state).toBe('outcome_unknown');

    // No request ID recorded: automatic success resolution is refused.
    const missing = await resolveUnknown(client, {
      generationId,
      decision: 'succeeded',
      operatorNote: 'guess without evidence',
    });
    expect(missing).toEqual({ resolved: false, reason: 'MISSING_REQUEST_ID' });

    const probe = await probeByRequestId(client, { generationId });
    expect(probe.requestId).toBeNull();

    // Operator marks it failed: explicit resolution works.
    const resolved = await resolveUnknown(client, {
      generationId,
      decision: 'failed',
      operatorNote: 'operator confirmed no billing',
    });
    expect(resolved).toEqual({ resolved: true, state: 'failed' });
  });

  it('captures the provider request ID from a 504 and reconciles to succeeded', async () => {
    counter += 1;
    const generationId = await createGeneration(`j06-rid-${counter}`);
    const [lease] = await claimJobs(client, { workerId: 'j06', kinds: ['generate'] });

    // Provider answers 504 with an x-request-id header: acceptance evidence.
    provider.scriptResponses([{ status: 504, body: '{"error":"upstream timeout"}' }]);
    const deps = await adapterDeps(fetch);
    const outcome = await executeClaimedJob(deps, { jobId: lease!.jobId, workerId: 'j06', generationId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('PROVIDER_TIMEOUT_UNKNOWN');
    }

    const generation = await client.query<{ state: string }>('SELECT state FROM generation WHERE id = $1', [generationId]);
    expect(generation.rows[0]!.state).toBe('outcome_unknown');

    // The request ID traveled: mock provider header → adapter → attempt row.
    const attempt = await client.query<{ state: string; provider_request_id: string | null }>(
      'SELECT state, provider_request_id FROM attempt WHERE generation_id = $1',
      [generationId],
    );
    expect(attempt.rows[0]!.state).toBe('unknown');
    expect(attempt.rows[0]!.provider_request_id).toMatch(/^mock-req-\d+$/);

    const probe = await probeByRequestId(client, { generationId });
    expect(probe.requestId).toBe(attempt.rows[0]!.provider_request_id);

    const resolved = await resolveUnknown(client, {
      generationId,
      decision: 'succeeded',
      operatorNote: `provider confirmed acceptance for ${probe.requestId ?? 'unknown'}`,
    });
    expect(resolved).toEqual({ resolved: true, state: 'succeeded' });

    // Quota is NOT released for the resolved success (the provider billed).
    const ledger = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM quota_ledger WHERE generation_id = $1 AND reason = 'release'`,
      [generationId],
    );
    expect(ledger.rows[0]!.n).toBe('0');
  });
});

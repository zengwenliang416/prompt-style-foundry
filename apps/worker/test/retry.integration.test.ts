import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startMockProvider, startPgTestCluster, type MockProviderHandle, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { LocalDiskStorage } from '../../api/src/infra/storage/storage.js';
import { importCatalogRelease, sha256Hex, stablePromptBody } from '../../api/src/modules/catalog/import.js';
import { UploadService } from '../../api/src/modules/media/upload-service.js';
import { PrecheckService } from '../../api/src/modules/media/precheck-service.js';
import { GenerationService } from '../../api/src/modules/generation/create.js';
import { claimJobs, completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';

/**
 * J07 acceptance: bounded retry driven by provider evidence — 429/503 with
 * Retry-After go back to the pending queue (and can still succeed later);
 * 401/parameter errors never retry; exhausting max_attempts dead-letters the
 * job and archives the failure (attempt rows keep status per try).
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let provider: MockProviderHandle;
let storage: LocalDiskStorage;
let storageRoot = '';
let subjectId = '';
let precheckId = '';
let counter = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('retry');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  provider = await startMockProvider();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'j07-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j07-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;

  const promptBody = '[System / Prompt]\nj07 body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j07-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-77',
        title: 'J07 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-77.txt',
        promptSha256: sha256Hex(stablePromptBody(promptBody)),
        source: null,
      },
    ],
  };
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-77.txt'), promptBody);
  await importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });

  const uploads = new UploadService(client, storage);
  const prechecks = new PrecheckService(client, storage);
  const created = await uploads.createUpload({ ownerId: subjectId, declaredBytes: PNG.length, declaredMime: 'image/png' });
  if (!created.ok) throw new Error('fixture failed');
  await uploads.putQuarantineBytes(created.value.uploadId, subjectId, PNG);
  const confirmed = await uploads.confirmUpload({ uploadId: created.value.uploadId, ownerId: subjectId, actualSha256: 'x' });
  if (!confirmed.ok) throw new Error('fixture failed');
  const precheck = await prechecks.createPrecheck({
    subjectId,
    templateKey: 'case-77',
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

async function createGeneration(): Promise<string> {
  counter += 1;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: database.uri });
  try {
    const service = new GenerationService({ pool }, 5);
    const result = await service.create({
      ownerId: subjectId,
      precheckId,
      idempotencyKey: `j07-${counter}`,
      providerId: 'direct-byok',
      model: 'gpt-image-2',
    });
    if (!result.ok) throw new Error(`generation failed: ${result.code}`);
    return result.generationId;
  } finally {
    await pool.end();
  }
}

function deps(): ExecutionDeps {
  return {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: 'direct-byok',
        label: 'BYOK',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-j07',
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage,
    providerId: 'direct-byok',
  };
}

async function jobRow(jobId: string): Promise<{ state: string; attempts: number; dead_reason: string | null; run_after: string }> {
  const row = await client.query<{ state: string; attempts: number; dead_reason: string | null; run_after: string }>(
    'SELECT state, attempts, dead_reason, run_after FROM job WHERE id = $1',
    [jobId],
  );
  return row.rows[0]!;
}

async function generationState(generationId: string): Promise<{ state: string; error_code: string | null }> {
  const row = await client.query<{ state: string; error_code: string | null }>(
    'SELECT state, error_code FROM generation WHERE id = $1',
    [generationId],
  );
  return row.rows[0]!;
}

describe('bounded retry + failure archival (J07)', () => {
  it('429 with Retry-After returns the job to pending and a later attempt succeeds', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;
    provider.scriptResponses([{ status: 429, body: '{"error":"rate limited"}', headers: { 'retry-after': '1' } }]);

    const [lease] = await claimJobs(client, { workerId: 'j07', kinds: ['generate'] });
    const first = await executeClaimedJob(deps(), { jobId: lease!.jobId, workerId: 'j07', generationId });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.errorCode).toBe('PROVIDER_REJECTED');
      expect(first.retried).toBe(true);
    }

    // Failure archived on the attempt; job back to pending with a delayed
    // run_after; generation stays queued (NOT failed while a retry remains).
    const attempt = await client.query<{ state: string; http_status: number | null; error_code: string | null }>(
      'SELECT state, http_status, error_code FROM attempt WHERE generation_id = $1',
      [generationId],
    );
    expect(attempt.rows[0]!.state).toBe('failed');
    expect(attempt.rows[0]!.http_status).toBe(429);
    expect(attempt.rows[0]!.error_code).toBe('PROVIDER_REJECTED');
    const jobAfterFirst = await jobRow(lease!.jobId);
    expect(jobAfterFirst.state).toBe('pending');
    expect(new Date(jobAfterFirst.run_after).getTime()).toBeGreaterThan(Date.now());
    expect((await generationState(generationId)).state).toBe('queued');

    // Retry after the Retry-After delay: second attempt succeeds end-to-end.
    await sleep(1100);
    const [reclaim] = await claimJobs(client, { workerId: 'j07', kinds: ['generate'] });
    expect(reclaim!.jobId).toBe(lease!.jobId);
    expect(reclaim!.attempts).toBe(2);
    const second = await executeClaimedJob(deps(), { jobId: lease!.jobId, workerId: 'j07', generationId });
    expect(second.ok).toBe(true);
    const completion = await completeJob(client, { jobId: lease!.jobId, workerId: 'j07', generationId, generationState: 'succeeded' });
    expect(completion.completed).toBe(true);
    expect(provider.requests.length).toBe(requestsBefore + 2);
    expect((await generationState(generationId)).state).toBe('succeeded');
  });

  it('429 without Retry-After is not retried: job dead, generation failed', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;
    provider.scriptResponses([{ status: 429, body: '{"error":"rate limited"}' }]);

    const [lease] = await claimJobs(client, { workerId: 'j07', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), { jobId: lease!.jobId, workerId: 'j07', generationId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retried).toBe(false);
    }
    const job = await jobRow(lease!.jobId);
    expect(job.state).toBe('dead');
    expect(job.dead_reason).toBe('PROVIDER_REJECTED');
    const generation = await generationState(generationId);
    expect(generation.state).toBe('failed');
    expect(generation.error_code).toBe('PROVIDER_REJECTED');
    // No resend: exactly one provider call, nothing claimable.
    expect(provider.requests.length).toBe(requestsBefore + 1);
    expect(await claimJobs(client, { workerId: 'other', kinds: ['generate'] })).toHaveLength(0);
  });

  it('401 is never retried even though nothing else changed', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;
    provider.scriptResponses([{ status: 401, body: '{"error":"bad key"}' }]);

    const [lease] = await claimJobs(client, { workerId: 'j07', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), { jobId: lease!.jobId, workerId: 'j07', generationId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retried).toBe(false);
    }
    const attempt = await client.query<{ http_status: number | null }>(
      'SELECT http_status FROM attempt WHERE generation_id = $1',
      [generationId],
    );
    expect(attempt.rows[0]!.http_status).toBe(401);
    expect((await jobRow(lease!.jobId)).state).toBe('dead');
    expect((await generationState(generationId)).state).toBe('failed');
    expect(provider.requests.length).toBe(requestsBefore + 1);
  });

  it('503 with Retry-After retries until attempts exhaust, then dead-letters', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;
    provider.scriptResponses([
      { status: 503, body: '{"error":"unavailable"}', headers: { 'retry-after': '1' } },
      { status: 503, body: '{"error":"unavailable"}', headers: { 'retry-after': '1' } },
      { status: 503, body: '{"error":"unavailable"}', headers: { 'retry-after': '1' } },
    ]);

    // attempts 1 and 2 retry; the third claim exhausts max_attempts (3).
    let jobId = '';
    for (let round = 1; round <= 3; round += 1) {
      const [lease] = await claimJobs(client, { workerId: 'j07', kinds: ['generate'] });
      jobId = lease!.jobId;
      const outcome = await executeClaimedJob(deps(), { jobId, workerId: 'j07', generationId });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.retried).toBe(round < 3);
      }
      if (round < 3) {
        await sleep(1100);
      }
    }

    const job = await jobRow(jobId);
    expect(job.state).toBe('dead');
    expect(job.dead_reason).toBe('PROVIDER_REJECTED');
    expect(job.attempts).toBe(3);
    expect((await generationState(generationId)).state).toBe('failed');

    // Failure archival: one attempt row per try, each with the 503 status.
    const attempts = await client.query<{ n: string; statuses: string }>(
      `SELECT count(*)::text AS n, string_agg(http_status::text, ',' ORDER BY attempt_no) AS statuses
       FROM attempt WHERE generation_id = $1`,
      [generationId],
    );
    expect(attempts.rows[0]!.n).toBe('3');
    expect(attempts.rows[0]!.statuses).toBe('503,503,503');
    expect(provider.requests.length).toBe(requestsBefore + 3);
    expect(await claimJobs(client, { workerId: 'other', kinds: ['generate'] })).toHaveLength(0);
  });

  it('a refused execution (tampered snapshot) dead-letters instead of looping', async () => {
    const generationId = await createGeneration();
    await client.query(
      `UPDATE template_version SET prompt_text = 'TAMPERED' WHERE prompt_text IS NOT NULL`,
    );
    const requestsBefore = provider.requests.length;

    const [lease] = await claimJobs(client, { workerId: 'j07', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), { jobId: lease!.jobId, workerId: 'j07', generationId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refused).toBe(true);
      expect(outcome.errorCode).toBe('PROMPT_REWRITE_BLOCKED');
    }
    const job = await jobRow(lease!.jobId);
    expect(job.state).toBe('dead');
    expect(job.dead_reason).toBe('PROMPT_REWRITE_BLOCKED');
    expect((await generationState(generationId)).state).toBe('failed');
    expect(provider.requests.length).toBe(requestsBefore);
  });
});

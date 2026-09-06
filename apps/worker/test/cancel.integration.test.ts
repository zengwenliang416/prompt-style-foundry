import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';

import { startMockProvider, startPgTestCluster, type MockProviderHandle, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { CancelService } from '../../api/src/modules/generation/cancel.js';
import { LocalDiskStorage } from '../../api/src/infra/storage/storage.js';
import { importCatalogRelease, sha256Hex, stablePromptBody } from '../../api/src/modules/catalog/import.js';
import { UploadService } from '../../api/src/modules/media/upload-service.js';
import { PrecheckService } from '../../api/src/modules/media/precheck-service.js';
import { GenerationService } from '../../api/src/modules/generation/create.js';
import { claimJobs, completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';

/**
 * J08 acceptance: queued cancels are real (job gone, quota released, zero
 * provider calls); a running cancel is only a REQUEST answered with
 * CANCEL_NOT_GUARANTEED (no upstream cancel API exists — none is invoked);
 * a success response racing a cancel request completes as succeeded (never
 * a fake "cancelled"); a cancel requested before the send point cancels
 * cleanly; terminal/foreign/missing generations get honest answers.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: Pool;
let cancels: CancelService;
let provider: MockProviderHandle;
let storage: LocalDiskStorage;
let storageRoot = '';
let subjectId = '';
let otherSubjectId = '';
let precheckId = '';
let counter = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('cancel');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  cancels = new CancelService(pool);
  provider = await startMockProvider();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'j08-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j08-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;
  const other = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j08-other', 'member') RETURNING id",
  );
  otherSubjectId = other.rows[0]!.id;

  const promptBody = '[System / Prompt]\nj08 body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j08-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-88',
        title: 'J08 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-88.txt',
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
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-88.txt'), promptBody);
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
    templateKey: 'case-88',
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
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

async function createGeneration(): Promise<string> {
  counter += 1;
  const service = new GenerationService({ pool }, 5);
  const result = await service.create({
    ownerId: subjectId,
    precheckId,
    idempotencyKey: `j08-${counter}`,
    providerId: 'direct-byok',
    model: 'gpt-image-2',
  });
  if (!result.ok) throw new Error(`generation failed: ${result.code}`);
  return result.generationId;
}

function deps(fetchImpl: typeof fetch): ExecutionDeps {
  return {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: 'direct-byok',
        label: 'BYOK',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-j08',
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl },
    ),
    storage,
    providerId: 'direct-byok',
  };
}

async function generationRow(generationId: string): Promise<{ state: string; cancel_requested_at: string | null }> {
  const row = await client.query<{ state: string; cancel_requested_at: string | null }>(
    'SELECT state, cancel_requested_at FROM generation WHERE id = $1',
    [generationId],
  );
  return row.rows[0]!;
}

async function releaseCount(generationId: string): Promise<number> {
  const row = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM quota_ledger WHERE generation_id = $1 AND reason = 'release'`,
    [generationId],
  );
  return Number(row.rows[0]!.n);
}

describe('cancel + race handling (J08)', () => {
  it('queued cancel: cancelled for real, job removed, quota released, idempotent', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;

    const first = await cancels.cancel({ generationId, subjectId });
    expect(first).toEqual({ ok: true, outcome: 'cancelled', state: 'cancelled' });
    expect((await generationRow(generationId)).state).toBe('cancelled');

    const job = await client.query<{ state: string; dead_reason: string | null }>(
      'SELECT state, dead_reason FROM job WHERE generation_id = $1',
      [generationId],
    );
    expect(job.rows[0]!.state).toBe('dead');
    expect(job.rows[0]!.dead_reason).toBe('cancelled');
    expect(await claimJobs(client, { workerId: 'j08', kinds: ['generate'] })).toHaveLength(0);
    // Never sent → never billed → reservation released.
    expect(provider.requests.length).toBe(requestsBefore);
    expect(await releaseCount(generationId)).toBe(1);

    // Repeated cancel is idempotent: honest terminal answer, no double release.
    const second = await cancels.cancel({ generationId, subjectId });
    expect(second).toEqual({ ok: true, outcome: 'already_terminal', state: 'cancelled' });
    expect(await releaseCount(generationId)).toBe(1);
  });

  it('running cancel request is honoured before the send point (never billed)', async () => {
    const generationId = await createGeneration();
    // Simulate the worker having picked the task up.
    await client.query(`UPDATE generation SET state = 'running' WHERE id = $1`, [generationId]);

    const cancel = await cancels.cancel({ generationId, subjectId });
    expect(cancel).toEqual({ ok: true, outcome: 'cancel_requested', state: 'running', code: 'CANCEL_NOT_GUARANTEED' });
    const during = await generationRow(generationId);
    expect(during.state).toBe('running');
    expect(during.cancel_requested_at).not.toBeNull();
    expect(await releaseCount(generationId)).toBe(0);

    // The worker reaches the pre-send check and cancels cleanly: no attempt,
    // no provider call, quota released, job buried.
    const requestsBefore = provider.requests.length;
    const [lease] = await claimJobs(client, { workerId: 'j08', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(fetch), { jobId: lease!.jobId, workerId: 'j08', generationId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('CANCELLED');
    }
    expect(provider.requests.length).toBe(requestsBefore);
    expect((await generationRow(generationId)).state).toBe('cancelled');
    expect(await releaseCount(generationId)).toBe(1);
    const attempts = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM attempt WHERE generation_id = $1',
      [generationId],
    );
    expect(attempts.rows[0]!.n).toBe('0');
    const job = await client.query<{ state: string; dead_reason: string | null }>(
      'SELECT state, dead_reason FROM job WHERE generation_id = $1',
      [generationId],
    );
    expect(job.rows[0]!.dead_reason).toBe('cancelled');
  });

  it('success racing a cancel request completes as succeeded (no fake cancelled)', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;

    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // The request is dispatched to the provider immediately; the response is
    // held back until the cancel request has been recorded.
    const holdingFetch: typeof fetch = (async (input: unknown, init: unknown) => {
      const pending = fetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
      await gate;
      return pending;
    }) as unknown as typeof fetch;

    const [lease] = await claimJobs(client, { workerId: 'j08', kinds: ['generate'] });
    const execution = executeClaimedJob(deps(holdingFetch), { jobId: lease!.jobId, workerId: 'j08', generationId });

    // Wait until the provider demonstrably accepted the request.
    for (let waited = 0; provider.requests.length === requestsBefore && waited < 5000; waited += 25) {
      await sleep(25);
    }
    expect(provider.requests.length).toBe(requestsBefore + 1);

    const cancel = await cancels.cancel({ generationId, subjectId });
    expect(cancel).toEqual({ ok: true, outcome: 'cancel_requested', state: 'running', code: 'CANCEL_NOT_GUARANTEED' });
    openGate();

    const outcome = await execution;
    expect(outcome.ok).toBe(true);
    const completion = await completeJob(client, { jobId: lease!.jobId, workerId: 'j08', generationId, generationState: 'succeeded' });
    expect(completion.completed).toBe(true);

    const after = await generationRow(generationId);
    expect(after.state).toBe('succeeded');
    expect(after.cancel_requested_at).not.toBeNull();
    // Billed → quota NOT released; result stored; every upstream call was the
    // edits endpoint (no cancel API exists or was invoked).
    expect(await releaseCount(generationId)).toBe(0);
    const result = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM result WHERE generation_id = $1', [generationId]);
    expect(result.rows[0]!.n).toBe('1');
    for (const req of provider.requests.slice(requestsBefore)) {
      expect(req.path).toBe('/v1/images/edits');
    }
  });

  it('honest refusals: terminal, outcome_unknown, foreign, missing', async () => {
    const succeededId = await createGeneration();
    const [lease] = await claimJobs(client, { workerId: 'j08', kinds: ['generate'] });
    await executeClaimedJob(deps(fetch), { jobId: lease!.jobId, workerId: 'j08', generationId: succeededId });
    await completeJob(client, { jobId: lease!.jobId, workerId: 'j08', generationId: succeededId, generationState: 'succeeded' });

    await expect(cancels.cancel({ generationId: succeededId, subjectId })).resolves.toEqual({
      ok: true,
      outcome: 'already_terminal',
      state: 'succeeded',
    });

    const unknownId = await createGeneration();
    await client.query(`UPDATE generation SET state = 'outcome_unknown' WHERE id = $1`, [unknownId]);
    await expect(cancels.cancel({ generationId: unknownId, subjectId })).resolves.toEqual({
      ok: false,
      code: 'GENERATION_STATE_ILLEGAL',
    });

    const foreignId = await createGeneration();
    await expect(cancels.cancel({ generationId: foreignId, subjectId: otherSubjectId })).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    // Cross-user cancel must leave the task untouched.
    expect((await generationRow(foreignId)).state).toBe('queued');

    await expect(
      cancels.cancel({ generationId: '00000000-0000-0000-0000-0000000000ff', subjectId }),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

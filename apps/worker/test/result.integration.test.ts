import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import sharp from 'sharp';

import {
  startMockProvider,
  startPgTestCluster,
  type MockProviderHandle,
  type PgTestCluster,
} from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { LocalDiskStorage } from '../../api/src/infra/storage/storage.js';
import { validateImage } from '../../api/src/modules/media/validate-image.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../../api/src/modules/catalog/import.js';
import { UploadService } from '../../api/src/modules/media/upload-service.js';
import { PrecheckService } from '../../api/src/modules/media/precheck-service.js';
import { GenerationService } from '../../api/src/modules/generation/create.js';
import { claimJobs, completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';

/**
 * J09 acceptance: provider results are verified before storage — fake MIME,
 * undecodable payloads, oversized images, and missing image data are rejected
 * (never retried, since a retry re-bills); the result row records ACTUAL
 * decoded mime/bytes/dimensions (the input here is 1×1, the results are not);
 * a storage failure after a successful paid call never re-calls the model.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: Pool;
let provider: MockProviderHandle;
let storage: LocalDiskStorage;
let storageRoot = '';
let subjectId = '';
let precheckId = '';
let counter = 0;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('result');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  provider = await startMockProvider();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'j09-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j09-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;

  const promptBody =
    '[System / Prompt]\nj09 body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j09-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-99',
        title: 'J09 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-99.txt',
        promptSha256: sha256Hex(stablePromptBody(promptBody)),
        source: null,
      },
    ],
  };
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, 'data/library/templates.json'),
    JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }),
  );
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-99.txt'), promptBody);
  await importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });

  const uploads = new UploadService(client, storage);
  const prechecks = new PrecheckService(client, storage);
  const created = await uploads.createUpload({
    ownerId: subjectId,
    declaredBytes: PNG_1X1.length,
    declaredMime: 'image/png',
  });
  if (!created.ok) throw new Error('fixture failed');
  await uploads.putQuarantineBytes(created.value.uploadId, subjectId, PNG_1X1);
  const confirmed = await uploads.confirmUpload({
    uploadId: created.value.uploadId,
    ownerId: subjectId,
    actualSha256: createHash('sha256').update(PNG_1X1).digest('hex'),
  });
  if (!confirmed.ok) throw new Error('fixture failed');
  const precheck = await prechecks.createPrecheck({
    subjectId,
    templateKey: 'case-99',
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
    idempotencyKey: `j09-${counter}`,
    providerId: 'direct-byok',
    model: 'gpt-image-2',
  });
  if (!result.ok) throw new Error(`generation failed: ${result.code}`);
  return result.generationId;
}

function deps(storageOverride?: ExecutionDeps['storage']): ExecutionDeps {
  return {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: 'direct-byok',
        label: 'BYOK',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-j09',
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage: storageOverride ?? storage,
    validateImage,
    providerId: 'direct-byok',
  };
}

function scriptImage(bytes: Buffer): void {
  provider.scriptResponses([
    { status: 200, body: JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }) },
  ]);
}

async function terminalRows(generationId: string): Promise<{
  generation: { state: string; error_code: string | null };
  job: { state: string; dead_reason: string | null };
  results: number;
}> {
  const generation = (
    await client.query<{ state: string; error_code: string | null }>(
      'SELECT state, error_code FROM generation WHERE id = $1',
      [generationId],
    )
  ).rows[0]!;
  const job = (
    await client.query<{ state: string; dead_reason: string | null }>(
      'SELECT state, dead_reason FROM job WHERE generation_id = $1',
      [generationId],
    )
  ).rows[0]!;
  const results = Number(
    (
      await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM result WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!.n,
  );
  return { generation, job, results };
}

describe('result verification + atomic completion (J09)', () => {
  it('rejects a fake-MIME payload (undecodable bytes): failed, dead, single paid call', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;
    scriptImage(Buffer.from('this is not an image at all, just text bytes'));

    const [lease] = await claimJobs(client, { workerId: 'j09', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), {
      jobId: lease!.jobId,
      workerId: 'j09',
      generationId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(outcome.retried).toBe(false);
    }
    const rows = await terminalRows(generationId);
    expect(rows.generation.state).toBe('failed');
    expect(rows.generation.error_code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(rows.job).toEqual({ state: 'dead', dead_reason: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(rows.results).toBe(0);
    // Garbage is never retried: exactly one paid call, nothing claimable.
    expect(provider.requests.length).toBe(requestsBefore + 1);
    expect(await claimJobs(client, { workerId: 'other', kinds: ['generate'] })).toHaveLength(0);
  });

  it('rejects a missing image (no b64 data): failed via PROVIDER_REJECTED', async () => {
    const generationId = await createGeneration();
    provider.scriptResponses([{ status: 200, body: '{"data":[{}]}' }]);

    const [lease] = await claimJobs(client, { workerId: 'j09', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), {
      jobId: lease!.jobId,
      workerId: 'j09',
      generationId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('PROVIDER_REJECTED');
    }
    const rows = await terminalRows(generationId);
    expect(rows.generation.state).toBe('failed');
    expect(rows.job.state).toBe('dead');
    expect(rows.results).toBe(0);
  });

  it('rejects an oversized image (48MP > 40MP ceiling): PIXEL_LIMIT_EXCEEDED', async () => {
    const generationId = await createGeneration();
    const huge = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: '#336699' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    scriptImage(huge);

    const [lease] = await claimJobs(client, { workerId: 'j09', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), {
      jobId: lease!.jobId,
      workerId: 'j09',
      generationId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('PIXEL_LIMIT_EXCEEDED');
    }
    const rows = await terminalRows(generationId);
    expect(rows.generation.state).toBe('failed');
    expect(rows.generation.error_code).toBe('PIXEL_LIMIT_EXCEEDED');
    expect(rows.job.state).toBe('dead');
    expect(rows.results).toBe(0);
  });

  it('storage failure after a paid success: dead-letters WITHOUT re-calling the model', async () => {
    const generationId = await createGeneration();
    const requestsBefore = provider.requests.length;
    const image = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    scriptImage(image);

    const failingStorage: ExecutionDeps['storage'] = {
      get: (input) => storage.get(input),
      put: () => Promise.reject(new Error('disk full')),
    };
    const [lease] = await claimJobs(client, { workerId: 'j09', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(failingStorage), {
      jobId: lease!.jobId,
      workerId: 'j09',
      generationId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('RESULT_STORAGE_FAILED');
    }

    const rows = await terminalRows(generationId);
    expect(rows.generation.state).toBe('failed');
    expect(rows.generation.error_code).toBe('RESULT_STORAGE_FAILED');
    expect(rows.job).toEqual({ state: 'dead', dead_reason: 'RESULT_STORAGE_FAILED' });
    // The attempt stays 'succeeded' — the provider DID deliver (truth kept).
    const attempt = (
      await client.query<{ state: string; error_code: string | null }>(
        'SELECT state, error_code FROM attempt WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!;
    expect(attempt.state).toBe('succeeded');
    expect(attempt.error_code).toBe('RESULT_STORAGE_FAILED');
    // Exactly one paid call and no resend path.
    expect(provider.requests.length).toBe(requestsBefore + 1);
    expect(await claimJobs(client, { workerId: 'other', kinds: ['generate'] })).toHaveLength(0);
  });

  it('success records ACTUAL decoded mime/bytes/dimensions, separately from the request', async () => {
    const generationId = await createGeneration();
    const actualImage = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    scriptImage(actualImage);

    const [lease] = await claimJobs(client, { workerId: 'j09', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps(), {
      jobId: lease!.jobId,
      workerId: 'j09',
      generationId,
    });
    expect(outcome.ok).toBe(true);
    const completion = await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'j09',
      generationId,
      generationState: 'succeeded',
    });
    expect(completion.completed).toBe(true);

    // Input was 1×1; the result is the provider's 3×2 — actuals come from
    // decoding the returned bytes, never from request parameters.
    const result = (
      await client.query<{
        actual_mime: string;
        actual_bytes: string;
        actual_width: number;
        actual_height: number;
      }>(
        'SELECT actual_mime, actual_bytes::text, actual_width, actual_height FROM result WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!;
    expect(result.actual_mime).toBe('image/png');
    expect(result.actual_width).toBe(3);
    expect(result.actual_height).toBe(2);
    expect(Number(result.actual_bytes)).toBe(actualImage.length);

    const media = (
      await client.query<{
        mime: string;
        width: number;
        height: number;
        sha256: string;
        bytes: string;
      }>(
        `SELECT m.mime, m.width, m.height, m.sha256, m.bytes::text
       FROM media_object m JOIN result r ON r.media_object_id = m.id WHERE r.generation_id = $1`,
        [generationId],
      )
    ).rows[0]!;
    expect(media).toMatchObject({ mime: 'image/png', width: 3, height: 2 });
    expect(media.sha256).toBe(createHash('sha256').update(actualImage).digest('hex'));
    expect(Number(media.bytes)).toBe(actualImage.length);
    expect((await terminalRows(generationId)).generation.state).toBe('succeeded');
  });
});

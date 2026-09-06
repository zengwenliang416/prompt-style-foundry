import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

import { startMockProvider, startPgTestCluster, type MockProviderHandle, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { LocalDiskStorage } from '../../api/src/infra/storage/storage.js';
import { importCatalogRelease, sha256Hex, stablePromptBody } from '../../api/src/modules/catalog/import.js';
import { UploadService } from '../../api/src/modules/media/upload-service.js';
import { PrecheckService } from '../../api/src/modules/media/precheck-service.js';
import { GenerationService } from '../../api/src/modules/generation/create.js';
import { claimJobs, completeJob } from '../src/queue.js';
import { executeClaimedJob } from '../src/execute.js';

/**
 * J05 acceptance: the worker sends the immutable compiled prompt verbatim
 * (hash-match between attempt.sent_prompt_sha256, the provider-received body,
 * and template_version.prompt_text); a tampered snapshot is refused without
 * any provider call; input/parameter substitution is impossible because the
 * generation row was frozen at creation.
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
const adapter = (): ProviderAdapter =>
  new ProviderAdapter(
    {
      providerId: 'direct-byok',
      label: 'BYOK',
      baseUrl: provider.baseUrl,
      apiKey: 'sk-j05-live-key',
      models: [{ id: 'gpt-image-2', qualities: ['high'] }],
    },
    { fetchImpl: fetch },
  );
const db = (): Queryable => client as unknown as Queryable;

interface Queryable {
  query<R extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('trace');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  provider = await startMockProvider();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'j05-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j05-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;

  const promptBody = '[System / Prompt]\nj05 verbatim body\nBEGIN VISUAL BLUEPRINT\nblue\nEND VISUAL BLUEPRINT\n';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j05-catalog-'));
  const fs = await import('node:fs/promises');
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-7',
        title: 'J05 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-7.txt',
        promptSha256: sha256Hex(stablePromptBody(promptBody)),
        source: null,
      },
    ],
  };
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-7.txt'), promptBody);
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
    templateKey: 'case-7',
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

async function createGeneration(key: string): Promise<string> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: database.uri });
  try {
    const service = new GenerationService({ pool }, 5);
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

describe('send traceability (J05)', () => {
  it('sends the compiled prompt verbatim and records a matching attempt hash', async () => {
    const generationId = await createGeneration('trace-1');
    const requestsBefore = provider.requests.length;
    const [lease] = await claimJobs(client, { workerId: 'j05', kinds: ['generate'] });
    expect(lease).toBeDefined();

    const outcome = await executeClaimedJob(
      { db: db(), adapter: adapter(), storage, providerId: 'direct-byok' },
      { jobId: lease!.jobId, workerId: 'j05', generationId },
    );
    expect(outcome.ok).toBe(true);

    // Successful execution completes the job via the J03 CAS machinery.
    const completion = await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'j05',
      generationId,
      generationState: 'succeeded',
    });
    expect(completion.completed).toBe(true);

    // The mock provider received EXACTLY the immutable snapshot text.
    const sent = provider.requests[requestsBefore]!;
    const body = JSON.parse(sent.body.toString());
    const snapshot = await client.query<{ prompt_text: string }>(
      'SELECT prompt_text FROM template_version WHERE compiled_prompt_sha256 = $1',
      [outcome.sentPromptSha256],
    );
    expect(body.prompt).toBe(snapshot.rows[0]!.prompt_text);
    expect(outcome.sentPromptSha256).toBe(
      createHash('sha256').update(body.prompt.replace(/\n+$/, '')).digest('hex'),
    );

    // Attempt row records the same hash + sent/succeeded states.
    const attempt = await client.query<{ sent_prompt_sha256: string; state: string }>(
      'SELECT sent_prompt_sha256, state FROM attempt WHERE generation_id = $1',
      [generationId],
    );
    expect(attempt.rows[0]!.sent_prompt_sha256).toBe(outcome.sentPromptSha256);
    expect(attempt.rows[0]!.state).toBe('succeeded');

    // Generation and result are terminal and consistent.
    const generation = await client.query<{ state: string }>('SELECT state FROM generation WHERE id = $1', [generationId]);
    expect(generation.rows[0]!.state).toBe('succeeded');
    const result = await client.query<{ actual_bytes: number }>('SELECT actual_bytes FROM result WHERE generation_id = $1', [generationId]);
    expect(Number(result.rows[0]!.actual_bytes)).toBeGreaterThan(0);
  });

  it('refuses execution when the prompt snapshot was tampered (no provider call)', async () => {
    const generationId = await createGeneration('trace-2');
    // Tamper: rewrite the snapshot text in place (simulating DB tampering).
    await client.query(
      `UPDATE template_version SET prompt_text = 'SHORTENED PROMPT' WHERE prompt_text IS NOT NULL`,
    );
    const requestsBefore = provider.requests.length;

    const [lease] = await claimJobs(client, { workerId: 'j05', kinds: ['generate'] });
    const outcome = await executeClaimedJob(
      { db: db(), adapter: adapter(), storage, providerId: 'direct-byok' },
      { jobId: lease!.jobId, workerId: 'j05', generationId },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refused).toBe(true);
      expect(outcome.errorCode).toBe('PROMPT_REWRITE_BLOCKED');
    }
    expect(provider.requests.length).toBe(requestsBefore);
  });
});

interface Queryable {
  query<R extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}
void sha256Hex;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import { GenerationService } from '../src/modules/generation/create.js';
import { QuotaService } from '../src/modules/quota/service.js';
import { PrecheckService } from '../src/modules/media/precheck-service.js';
import { UploadService } from '../src/modules/media/upload-service.js';
import { LocalDiskStorage } from '../src/infra/storage/storage.js';
import { importCatalogRelease, sha256Hex, stablePromptBody } from '../src/modules/catalog/import.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * J01/J02 acceptance: same idempotency key returns the same task, a different
 * request under the same key conflicts, concurrent creations reserve quota
 * exactly once, and generation+job are atomic (rollback leaves no half task).
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: import('pg').Pool;
let service: GenerationService;
let subjectId = '';
let precheckId = '';
let storageRoot = '';

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('generation');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  const { Pool: PgPool } = await import('pg');
  pool = new PgPool({ connectionString: database.uri });

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j01-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;

  storageRoot = await mkdtemp(path.join(tmpdir(), 'j01-storage-'));
  const storage = new LocalDiskStorage(storageRoot);

  // Import a one-template catalog (B02) and precheck an upload (M01–M04).
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j01-catalog-'));
  const fs = await import('node:fs/promises');
  const promptBody = '[System / Prompt]\nj01 body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-42',
        title: 'J01 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-42.txt',
        promptSha256: sha256Hex(stablePromptBody(promptBody)),
        source: null,
      },
    ],
  };
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-42.txt'), promptBody);
  await importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });

  const uploads = new UploadService(client, storage);
  const prechecks = new PrecheckService(client, storage);
  const created = await uploads.createUpload({ ownerId: subjectId, declaredBytes: PNG.length, declaredMime: 'image/png' });
  if (!created.ok) throw new Error('fixture upload failed');
  await uploads.putQuarantineBytes(created.value.uploadId, subjectId, PNG);
  const confirmed = await uploads.confirmUpload({ uploadId: created.value.uploadId, ownerId: subjectId, actualSha256: 'fixture' });
  if (!confirmed.ok) throw new Error('fixture confirm failed');

  const precheck = await prechecks.createPrecheck({
    subjectId,
    templateKey: 'case-42',
    version: 1,
    mediaObjectId: confirmed.value.mediaObjectId,
    settings: { model: 'gpt-image-2', quality: 'high', aspect: 'inherit' },
  });
  if (!precheck.ok) throw new Error(`fixture precheck failed: ${precheck.problem}`);
  precheckId = precheck.value.precheckId;

  service = new GenerationService({ pool }, 5);
  // The quota limit is unused in J01 asserts but wired for realism.
  void new QuotaService(client, { limit: 5 });
});

afterAll(async () => {
  await pool?.end();
  await client?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

describe('generation creation (J01/J02)', () => {
  it('creates a queued task with a job row atomically', async () => {
    const result = await service.create({
      ownerId: subjectId,
      precheckId,
      idempotencyKey: 'key-1',
      providerId: 'direct-byok',
      model: 'gpt-image-2',
    });
    expect(result).toMatchObject({ ok: true, created: true, state: 'queued' });

    const job = await client.query<{ state: string; kind: string }>(
      'SELECT state, kind FROM job WHERE generation_id = $1',
      [result.ok ? result.generationId : ''],
    );
    expect(job.rows[0]).toMatchObject({ state: 'pending', kind: 'generate' });
  });

  it('replays the same key+fingerprint to the SAME task (no second row)', async () => {
    const replay = await service.create({
      ownerId: subjectId,
      precheckId,
      idempotencyKey: 'key-1',
      providerId: 'direct-byok',
      model: 'gpt-image-2',
    });
    expect(replay).toMatchObject({ ok: true, created: false });

    const rows = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM generation WHERE idempotency_key = 'key-1'",
    );
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('conflicts (409 semantics) when the same key carries a different request', async () => {
    const conflict = await service.create({
      ownerId: subjectId,
      precheckId,
      idempotencyKey: 'key-1',
      providerId: 'direct-byok',
      model: 'custom', // Different fingerprint.
    });
    expect(conflict).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('reserves quota exactly once under concurrent same-key creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.create({
          ownerId: subjectId,
          precheckId,
          idempotencyKey: 'concurrent-key',
          providerId: 'direct-byok',
          model: 'gpt-image-2',
        }),
      ),
    );
    const ok = results.filter((r) => r.ok);
    const generationIds = new Set(ok.map((r) => (r as { generationId: string }).generationId));
    expect(generationIds.size).toBe(1);

    const ledger = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM quota_ledger
       WHERE generation_id = $1 AND reason = 'reserve'`,
      [generationIds.values().next().value],
    );
    expect(ledger.rows[0]!.n).toBe('1');
  });

  it('rolls back the whole task when the job insert fails (J02)', async () => {
    // Simulate job-table failure: drop the table inside a savepoint-safe way.
    await client.query('ALTER TABLE job RENAME TO job_backup');
    try {
      const result = await service.create({
        ownerId: subjectId,
        precheckId,
        idempotencyKey: 'rollback-key',
        providerId: 'direct-byok',
        model: 'gpt-image-2',
      });
      // The service surfaces the error via thrown exception; either way the
      // generation must not exist.
      void result;
    } catch {
      // Expected: job insert failed.
    } finally {
      await client.query('ALTER TABLE job_backup RENAME TO job');
    }

    const rows = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM generation WHERE idempotency_key = 'rollback-key'",
    );
    expect(rows.rows[0]!.n).toBe('0');
  });
});

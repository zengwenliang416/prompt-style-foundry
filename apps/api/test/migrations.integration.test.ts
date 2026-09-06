import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { appliedVersions, runMigrations } from '../src/db/migrate.js';

/**
 * B01 acceptance: migrations apply to an empty database and upgrade an
 * already-migrated one; foreign keys, unique constraints, and the key query
 * indexes from the backend data dictionary exist and are enforced.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let subjectId = '';

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('migrations');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  // Seed one subject used by the constraint tests.
  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'alice', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
  await cluster?.stop();
});

async function tableNames(uri: string): Promise<string[]> {
  const probe = new Client({ connectionString: uri });
  try {
    await probe.connect();
    const tables = await probe.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return tables.rows.map((row) => row.table_name);
  } finally {
    await probe.end();
  }
}

const EXPECTED_TABLES = [
  'subject',
  'session',
  'catalog_release',
  'template_version',
  'media_object',
  'upload',
  'precheck',
  'generation',
  'attempt',
  'result',
  'job',
  'quota_ledger',
  'collection',
  'collection_item',
  'audit_event',
  'deletion_manifest',
];

describe('migrations (B01)', () => {
  it('applies all migrations to an empty database and is idempotent', async () => {
    // beforeAll already applied 1..3; a re-run must be a no-op.
    const secondRun = await runMigrations(database.uri);
    expect(secondRun).toEqual([]);
    await expect(appliedVersions(database.uri)).resolves.toEqual([1, 2, 3, 4, 5]);

    const names = await tableNames(database.uri);
    for (const expected of EXPECTED_TABLES) {
      expect(names).toContain(expected);
    }
  });

  it('upgrades an existing database incrementally (to-version gating)', async () => {
    const upgradeDb = await cluster.createDatabase('upgrade');
    try {
      await runMigrations(upgradeDb.uri, { to: 1 });
      await expect(appliedVersions(upgradeDb.uri)).resolves.toEqual([1]);

      const earlyTables = await tableNames(upgradeDb.uri);
      expect(earlyTables).toContain('subject');
      expect(earlyTables).not.toContain('generation');

      const newlyApplied = await runMigrations(upgradeDb.uri);
      expect(newlyApplied.map((migration) => migration.version)).toEqual([2, 3, 4, 5]);
      const allTables = await tableNames(upgradeDb.uri);
      for (const expected of EXPECTED_TABLES) {
        expect(allTables).toContain(expected);
      }
    } finally {
      await upgradeDb.drop();
    }
  });

  it('enforces foreign keys on generation references', async () => {
    await expect(
      client.query(
        `INSERT INTO generation (owner_id, template_version_id, catalog_release_id, precheck_id,
           input_object_id, input_sha256, compiled_prompt_sha256, effective_prompt_sha256,
           provider_id, model, settings, idempotency_key, state)
         VALUES ($1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
           '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004',
           'abc', 'def', 'def', 'p', 'm', '{}', 'fk-missing', 'queued')`,
        [subjectId],
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('enforces the idempotency unique constraint on generations', async () => {
    const release = await client.query<{ id: string }>(
      `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
       VALUES ('1.1.0', 'src', 'lib-b01-unique', 1) RETURNING id`,
    );
    const releaseId = release.rows[0]!.id;
    const version = await client.query<{ id: string }>(
      `INSERT INTO template_version (catalog_release_id, template_key, version,
         compiled_prompt_sha256, blueprint_sha256, metadata)
       VALUES ($1, 'case-1', 1, 'psha-b01', 'bsha-b01', '{}') RETURNING id`,
      [releaseId],
    );
    const versionId = version.rows[0]!.id;
    const media = await client.query<{ id: string }>(
      `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
       VALUES ($1, 'input', 'ready', 'bucket-b01', 'k1', 'isha-b01', now() + interval '1 day') RETURNING id`,
      [subjectId],
    );
    const mediaId = media.rows[0]!.id;
    const precheck = await client.query<{ id: string }>(
      `INSERT INTO precheck (subject_id, media_object_id, template_version_id, settings,
         result, expires_at)
       VALUES ($1, $2, $3, '{}', 'passed', now() + interval '1 hour') RETURNING id`,
      [subjectId, mediaId, versionId],
    );
    const precheckId = precheck.rows[0]!.id;

    const insertGeneration = (key: string): Promise<unknown> =>
      client.query(
        `INSERT INTO generation (owner_id, template_version_id, catalog_release_id, precheck_id,
           input_object_id, input_sha256, compiled_prompt_sha256, effective_prompt_sha256,
           provider_id, model, settings, idempotency_key, state)
         VALUES ($1, $2, $3, $4, $5, 'isha-b01', 'psha-b01', 'psha-b01', 'provider', 'model', '{}', $6, 'queued')`,
        [subjectId, versionId, releaseId, precheckId, mediaId, key],
      );

    await insertGeneration('b01-key-1');
    await expect(insertGeneration('b01-key-1')).rejects.toThrow(
      /generation_owner_idempotency_unique/,
    );
    await insertGeneration('b01-key-2');
  });

  it('rejects illegal state values via check constraints', async () => {
    await expect(
      client.query(
        `INSERT INTO job (generation_id, kind, state, run_after)
         SELECT id, 'generate', 'flying', now() FROM generation LIMIT 1`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('keeps quota accounting idempotent per (generation, reason)', async () => {
    const generationId = (
      await client.query<{ id: string }>('SELECT id FROM generation ORDER BY created_at LIMIT 1')
    ).rows[0]!.id;

    await client.query(
      `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason) VALUES ($1, $2, -1, 'reserve')`,
      [subjectId, generationId],
    );
    await expect(
      client.query(
        `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason) VALUES ($1, $2, -1, 'reserve')`,
        [subjectId, generationId],
      ),
    ).rejects.toThrow(/quota_ledger_generation_reason_unique/);
  });

  it('supports idempotent collection items via primary key', async () => {
    const collection = await client.query<{ id: string }>(
      `INSERT INTO collection (owner_id, name) VALUES ($1, 'favorites') RETURNING id`,
      [subjectId],
    );
    const collectionId = collection.rows[0]!.id;

    const insertItem = (): Promise<unknown> =>
      client.query(
        `INSERT INTO collection_item (collection_id, item_type, item_key)
         VALUES ($1, 'template', 'case-1') ON CONFLICT DO NOTHING`,
        [collectionId],
      );
    await insertItem();
    await insertItem();

    const count = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection_item WHERE collection_id = $1',
      [collectionId],
    );
    expect(count.rows[0]!.n).toBe('1');

    // Cascade delete: removing the collection removes its items.
    await client.query('DELETE FROM collection WHERE id = $1', [collectionId]);
    const after = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection_item WHERE collection_id = $1',
      [collectionId],
    );
    expect(after.rows[0]!.n).toBe('0');
  });

  it('creates the key query indexes from the data dictionary', async () => {
    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const names = indexes.rows.map((row) => row.indexname);
    const expected = [
      'subject_issuer_claim_unique',
      'session_expires_idx',
      'template_version_key_version_unique',
      'media_object_owner_kind_idx',
      'media_object_state_expires_idx',
      'precheck_subject_created_idx',
      'generation_owner_idempotency_unique',
      'generation_owner_created_idx',
      'generation_state_idx',
      'attempt_generation_no_unique',
      'attempt_provider_request_idx',
      'job_state_run_after_idx',
      'job_lease_expires_idx',
      'quota_ledger_generation_reason_unique',
      'collection_owner_name_unique',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });
});

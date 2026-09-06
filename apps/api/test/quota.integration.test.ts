import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import { QuotaService } from '../src/modules/quota/service.js';
import { RateLimiter, safeQuotaError } from '../src/modules/policy/rate-limit.js';

/**
 * B05 acceptance: concurrent reserves never oversubscribe the limit,
 * reserve/release are idempotent, outcome_unknown never releases, and error
 * surfaces stay free of secret material.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: import('pg').Pool;
let subjectId = '';

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('quota');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: database.uri });

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'quota-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;
});

afterAll(async () => {
  await pool?.end();
  await client?.end();
  await database?.drop();
  await cluster?.stop();
});

/** Creates a full valid generation chain in the given state. */
async function seedGeneration(index: number, state: string): Promise<string> {
  const release = await client.query<{ id: string }>(
    `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
     VALUES ('1.1.0', 'src', $1, 1) RETURNING id`,
    [`lib-b05-${index}-${state}`],
  );
  const releaseId = release.rows[0]!.id;
  const version = await client.query<{ id: string }>(
    `INSERT INTO template_version (catalog_release_id, template_key, version,
       compiled_prompt_sha256, blueprint_sha256, metadata)
     VALUES ($1, $2, 1, $3, 'b', '{}') RETURNING id`,
    [releaseId, `case-b05-${index}`, `psha-b05-${index}-${state}`],
  );
  const versionId = version.rows[0]!.id;
  const media = await client.query<{ id: string }>(
    `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
     VALUES ($1, 'input', 'ready', $2, $3, 'isha', now() + interval '1 day') RETURNING id`,
    [subjectId, `bucket-b05-${index}`, `key-b05-${index}-${state}`],
  );
  const mediaId = media.rows[0]!.id;
  const precheck = await client.query<{ id: string }>(
    `INSERT INTO precheck (subject_id, media_object_id, template_version_id, settings,
       result, expires_at)
     VALUES ($1, $2, $3, '{}', 'passed', now() + interval '1 hour') RETURNING id`,
    [subjectId, mediaId, versionId],
  );
  const generation = await client.query<{ id: string }>(
    `INSERT INTO generation (owner_id, template_version_id, catalog_release_id, precheck_id,
       input_object_id, input_sha256, compiled_prompt_sha256, effective_prompt_sha256,
       provider_id, model, settings, idempotency_key, state)
     VALUES ($1, $2, $3, $4, $5, 'isha', 'psha', 'psha', 'provider', 'model', '{}', $6, $7) RETURNING id`,
    [subjectId, versionId, releaseId, precheck.rows[0]!.id, mediaId, `b05-idem-${index}-${state}`, state],
  );
  return generation.rows[0]!.id;
}

describe('quota service (B05)', () => {
  it('reserves idempotently: replaying a generation does not double-charge', async () => {
    const service = new QuotaService(client, { limit: 5 });
    const generationId = await seedGeneration(1, 'queued');

    const first = await service.reserve({ subjectId, generationId });
    expect(first).toEqual({ ok: true, used: 1 });
    const replay = await service.reserve({ subjectId, generationId });
    expect(replay).toEqual({ ok: false, code: 'ALREADY_RESERVED' });
  });

  it('never releases quota for outcome_unknown or succeeded tasks', async () => {
    const unknownId = await seedGeneration(2, 'outcome_unknown');
    const service = new QuotaService(client, { limit: 5 });
    await service.reserve({ subjectId, generationId: unknownId });
    await expect(
      service.release({ subjectId, generationId: unknownId }),
    ).resolves.toEqual({ ok: false, code: 'ILLEGAL_RELEASE' });

    const succeededId = await seedGeneration(3, 'succeeded');
    await service.reserve({ subjectId, generationId: succeededId });
    await expect(
      service.release({ subjectId, generationId: succeededId }),
    ).resolves.toEqual({ ok: false, code: 'ILLEGAL_RELEASE' });
  });

  it('releases exactly once for failed tasks', async () => {
    const failedId = await seedGeneration(4, 'failed');
    const service = new QuotaService(client, { limit: 5 });
    await service.reserve({ subjectId, generationId: failedId });

    const release = await service.release({ subjectId, generationId: failedId });
    expect(release).toEqual({ ok: true, used: expect.any(Number) });
    const replay = await service.release({ subjectId, generationId: failedId });
    expect(replay).toEqual({ ok: false, code: 'ALREADY_RESERVED' });
  });

  it('keeps concurrent reserves within the limit', async () => {
    // Dedicated subject: earlier tests' unreleased reservations (unknown and
    // succeeded tasks) must not eat into this test's budget.
    const concurrencySubject = (
      await client.query<{ id: string }>(
        "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'quota-concurrent', 'member') RETURNING id",
      )
    ).rows[0]!.id;
    subjectId = concurrencySubject;
    const limit = 2;
    // Parallel callers each need their own connection: exercise the Pool path.
    const service = new QuotaService(pool, { limit });
    const generationIds = await Promise.all([
      seedGeneration(10, 'queued'),
      seedGeneration(11, 'queued'),
      seedGeneration(12, 'queued'),
      seedGeneration(13, 'queued'),
      seedGeneration(14, 'queued'),
    ]);

    const outcomes = await Promise.all(
      generationIds.map((generationId) => service.reserve({ subjectId, generationId })),
    );
    const succeeded = outcomes.filter((outcome) => outcome.ok);
    const exceeded = outcomes.filter(
      (outcome) => !outcome.ok && outcome.code === 'QUOTA_EXCEEDED',
    );
    expect(succeeded, JSON.stringify(outcomes)).toHaveLength(2);
    expect(exceeded, JSON.stringify(outcomes)).toHaveLength(3);

    // Terminal-state transition (failed) is what makes a reservation
    // releasable; in-flight (queued) reservations are held.
    const firstOk = outcomes.findIndex((outcome) => outcome.ok);
    await client.query(`UPDATE generation SET state = 'failed' WHERE id = $1`, [
      generationIds[firstOk]!,
    ]);
    await service.release({ subjectId, generationId: generationIds[firstOk]! });
    const next = await service.reserve({ subjectId, generationId: await seedGeneration(15, 'queued') });
    expect(next).toEqual({ ok: true, used: limit });
  });

  it('reports active generation counts for the concurrency limit', async () => {
    const service = new QuotaService(pool, { limit: 5 });
    const active = await service.activeGenerations(subjectId);
    // All queued seeds minus released/failed ones still count here.
    expect(active).toBeGreaterThan(0);
  });
});

describe('rate limiter (B05)', () => {
  it('allows up to the limit then demands a retry delay', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.hit('subject-a:generations').allowed).toBe(true);
    expect(limiter.hit('subject-a:generations').allowed).toBe(true);
    expect(limiter.hit('subject-a:generations').allowed).toBe(true);

    const blocked = limiter.hit('subject-a:generations');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // A different subject is unaffected.
    expect(limiter.hit('subject-b:generations').allowed).toBe(true);
  });
});

describe('error sanitation (B05)', () => {
  it('strips secret-looking material from error messages', () => {
    expect(safeQuotaError('provider call with sk-live-abcdef failed')).toBe('internal quota error');
    expect(safeQuotaError('Authorization: Bearer abc123 rejected')).toBe('internal quota error');
    expect(safeQuotaError('quota exceeded')).toBe('quota exceeded');
  });
});

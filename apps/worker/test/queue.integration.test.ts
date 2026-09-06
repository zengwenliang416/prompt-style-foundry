// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import {
  claimJobs,
  completeJob,
  failJob,
  heartbeat,
  reclaimExpiredLeases,
} from '../src/queue.js';

/**
 * J03 acceptance on real PG: double-worker exclusion, lease expiry reclaim,
 * stale-worker completion rejection, no repeated success execution, bounded
 * retry with dead lettering.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('queue');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
  await cluster?.stop();
});

/** Seeds a subject + generation + pending job; returns the generation id. */
async function seedJob(state = 'queued', kind = 'generate'): Promise<string> {
  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', $1, 'member') RETURNING id",
    [`j03-${Math.random().toString(36).slice(2)}`],
  );
  const ownerId = subject.rows[0]!.id;
  const release = await client.query<{ id: string }>(
    `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
     VALUES ('1.1.0', 'src', $1, 1) RETURNING id`,
    [`lib-${Math.random().toString(36).slice(2)}`],
  );
  const version = await client.query<{ id: string }>(
    `INSERT INTO template_version (catalog_release_id, template_key, version,
       compiled_prompt_sha256, blueprint_sha256, metadata)
     VALUES ($1, $2, 1, $3, 'b', '{}') RETURNING id`,
    [release.rows[0]!.id, `case-j03-${Math.random().toString(36).slice(2)}`, `sha-${Math.random()}`],
  );
  const media = await client.query<{ id: string }>(
    `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
     VALUES ($1, 'input', 'ready', 'b', $2, 'sha', now() + interval '1 day') RETURNING id`,
    [ownerId, `key-${Math.random().toString(36).slice(2)}`],
  );
  const precheck = await client.query<{ id: string }>(
    `INSERT INTO precheck (subject_id, media_object_id, template_version_id, settings,
       result, expires_at)
     VALUES ($1, $2, $3, '{}', 'passed', now() + interval '1 hour') RETURNING id`,
    [ownerId, media.rows[0]!.id, version.rows[0]!.id],
  );
  const generation = await client.query<{ id: string }>(
    `INSERT INTO generation (owner_id, template_version_id, catalog_release_id, precheck_id,
       input_object_id, input_sha256, compiled_prompt_sha256, effective_prompt_sha256,
       provider_id, model, settings, idempotency_key, state)
     VALUES ($1, $2, $3, $4, $5, 'sha', 'p', 'p', 'provider', 'model', '{}', $6, $7) RETURNING id`,
    [ownerId, version.rows[0]!.id, release.rows[0]!.id, precheck.rows[0]!.id, media.rows[0]!.id,
     `idem-${Math.random().toString(36).slice(2)}`, state],
  );
  const generationId = generation.rows[0]!.id;
  await client.query(`INSERT INTO job (generation_id, kind, state, run_after) VALUES ($1, $2, 'pending', now())`, [generationId, kind]);
  return generationId;
}

describe('job queue machinery (J03)', () => {
  it('double workers claim distinct jobs (FOR UPDATE SKIP LOCKED)', async () => {
    const g1 = await seedJob();
    const g2 = await seedJob();

    const [workerOne, workerTwo] = await Promise.all([
      claimJobs(client, { workerId: 'w1', batch: 1 }),
      claimJobs(client, { workerId: 'w2', batch: 1 }),
    ]);
    expect(workerOne).toHaveLength(1);
    expect(workerTwo).toHaveLength(1);
    const ids = [workerOne[0]!.generationId, workerTwo[0]!.generationId];
    expect(new Set(ids)).toEqual(new Set([g1, g2]));
    void [g1, g2];
  });

  it('expires leases, lets another worker reclaim, and rejects the stale lease on completion', async () => {
    const generationId = await seedJob();
    const [lease] = await claimJobs(client, { workerId: 'stale-worker', leaseSeconds: -1 });
    // Lease already expired (negative lease for the test).

    const reclaimed = await reclaimExpiredLeases(client);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const [newLease] = await claimJobs(client, { workerId: 'fresh-worker', leaseSeconds: 60 });
    expect(newLease?.generationId).toBe(generationId);

    // Stale worker tries to complete: CAS rejects (LEASE_LOST).
    const stale = await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'stale-worker',
      generationId,
      generationState: 'succeeded',
    });
    expect(stale).toEqual({ completed: false, reason: 'LEASE_LOST' });

    // Fresh worker completes normally.
    const fresh = await completeJob(client, {
      jobId: newLease!.jobId,
      workerId: 'fresh-worker',
      generationId,
      generationState: 'succeeded',
    });
    expect(fresh.completed).toBe(true);

    const generation = await client.query<{ state: string }>('SELECT state FROM generation WHERE id = $1', [generationId]);
    expect(generation.rows[0]!.state).toBe('succeeded');
  });

  it('never re-executes an already-terminal generation', async () => {
    const generationId = await seedJob('succeeded');
    await client.query(
      `INSERT INTO job (generation_id, kind, state, run_after) VALUES ($1, 'generate', 'pending', now())`,
      [generationId],
    );
    const [lease] = await claimJobs(client, { workerId: 'w', leaseSeconds: 60 });

    const completion = await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'w',
      generationId,
      generationState: 'succeeded',
    });
    expect(completion).toEqual({ completed: true, reason: 'ALREADY_TERMINAL' });

    const generation = await client.query<{ state: string; completed_at: Date | null }>(
      'SELECT state, completed_at FROM generation WHERE id = $1',
      [generationId],
    );
    expect(generation.rows[0]!.state).toBe('succeeded');
  });

  it('heartbeats only extend the lease of the owning worker', async () => {
    await seedJob();
    const [lease] = await claimJobs(client, { workerId: 'owner', leaseSeconds: 60 });

    const wrongWorker = await heartbeat(client, { jobId: lease!.jobId, workerId: 'intruder', leaseSeconds: 60 });
    expect(wrongWorker).toBe(false);

    const owner = await heartbeat(client, { jobId: lease!.jobId, workerId: 'owner', leaseSeconds: 120 });
    expect(owner).toBe(true);

    const row = await client.query<{ lease_expires_at: string }>('SELECT lease_expires_at FROM job WHERE id = $1', [lease!.jobId]);
    expect(new Date(row.rows[0]!.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 60000);
  });

  it('dead-letters exhausted retries and fails the generation', async () => {
    const generationId = await seedJob('queued', 'dead-letter-test');
    await client.query(`UPDATE job SET max_attempts = 1 WHERE generation_id = $1`, [generationId]);
    const [lease] = await claimJobs(client, { workerId: 'w', leaseSeconds: 60, kinds: ['dead-letter-test'] });

    const outcome = await failJob(client, {
      jobId: lease!.jobId,
      workerId: 'w',
      generationId,
      reason: 'PROVIDER_REJECTED',
      retryable: true,
    });
    expect(outcome).toEqual({ retried: false, dead: true });

    const job = await client.query<{ state: string; dead_reason: string | null }>('SELECT state, dead_reason FROM job WHERE id = $1', [lease!.jobId]);
    expect(job.rows[0]!.state).toBe('dead');
    expect(job.rows[0]!.dead_reason).toBe('PROVIDER_REJECTED');
    const generation = await client.query<{ state: string; error_code: string | null }>('SELECT state, error_code FROM generation WHERE id = $1', [generationId]);
    expect(generation.rows[0]!.state).toBe('failed');
    expect(generation.rows[0]!.error_code).toBe('PROVIDER_REJECTED');
  });

  it('returns retryable failures to pending within bounds', async () => {
    const generationId = await seedJob('queued', 'retry-test');
    await client.query(`UPDATE job SET max_attempts = 3 WHERE generation_id = $1`, [generationId]);
    const [lease] = await claimJobs(client, { workerId: 'w', leaseSeconds: 60, kinds: ['retry-test'] });

    const outcome = await failJob(client, {
      jobId: lease!.jobId,
      workerId: 'w',
      generationId,
      reason: 'RATE_LIMITED',
      retryable: true,
      retryDelaySeconds: 1,
    });
    expect(outcome).toEqual({ retried: true, dead: false });

    const job = await client.query<{ state: string; attempts: number }>('SELECT state, attempts FROM job WHERE id = $1', [lease!.jobId]);
    expect(job.rows[0]!.state).toBe('pending');
    expect(job.rows[0]!.attempts).toBe(1);
  });
});

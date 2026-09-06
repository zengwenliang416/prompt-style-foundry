/** Structural query interface satisfied by pg Client/Pool/PoolClient. */
export interface Queryable {
  query<R extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * PG job queue machinery (J03, ADR 0001 D-3): claim via
 * FOR UPDATE SKIP LOCKED, heartbeat/lease extension, CAS-guarded completion,
 * expired-lease reclaim, and bounded-retry dead lettering.
 *
 * Invariants proven by tests:
 * - two workers never claim the same job;
 * - a worker whose lease expired CANNOT complete the job (CAS owner check);
 * - a job whose generation already succeeded is marked done without
 *   re-execution effects (no repeated success writes);
 * - failures increment attempts; exhausting max_attempts dead-letters with a
 *   reason.
 */

export interface ClaimedJob {
  jobId: string;
  generationId: string;
  kind: string;
  attempts: number;
  maxAttempts: number;
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds?: number;
  batch?: number;
  kinds?: string[];
}

export async function claimJobs(
  db: Queryable,
  options: ClaimOptions,
): Promise<ClaimedJob[]> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const batch = options.batch ?? 1;
  const kinds = options.kinds ?? ['generate'];
  const result = await db.query<{ id: string; generation_id: string; kind: string; attempts: number; max_attempts: number }>(
    `UPDATE job SET state = 'leased', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $2),
       heartbeat_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM job
       WHERE state = 'pending' AND run_after <= now() AND kind = ANY($3)
       ORDER BY run_after
       FOR UPDATE SKIP LOCKED
       LIMIT $4
     )
     RETURNING id, generation_id, kind, attempts, max_attempts`,
    [options.workerId, leaseSeconds, kinds, batch],
  );
  return result.rows.map((row) => ({
    jobId: row.id,
    generationId: row.generation_id,
    kind: row.kind,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

export async function heartbeat(db: Queryable, input: { jobId: string; workerId: string; leaseSeconds: number }): Promise<boolean> {
  const result = await db.query(
    `UPDATE job SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND lease_owner = $2 AND state = 'leased'`,
    [input.jobId, input.workerId, input.leaseSeconds],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface CompletionContext {
  jobId: string;
  workerId: string;
  generationId: string;
  /** Final generation state to CAS into (e.g. succeeded/failed). */
  generationState: 'succeeded' | 'failed';
  errorCode?: string;
}

/**
 * Completes a job under CAS: both the job row and the generation state
 * transition are guarded by the lease owner, so a stale worker cannot write.
 * If the generation is already terminal, the job is simply marked done —
 * success is never re-executed.
 */
export async function completeJob(
  db: Queryable,
  input: CompletionContext,
): Promise<{ completed: boolean; reason?: 'LEASE_LOST' | 'ALREADY_TERMINAL' }> {
  await db.query('BEGIN');
  try {
    const job = await db.query<{ lease_owner: string; state: string }>(
      `SELECT lease_owner, state FROM job WHERE id = $1 FOR UPDATE`,
      [input.jobId],
    );
    const row = job.rows[0];
    if (row === undefined || row.state !== 'leased' || row.lease_owner !== input.workerId) {
      await db.query('ROLLBACK');
      return { completed: false, reason: 'LEASE_LOST' };
    }

    const generation = await db.query<{ state: string }>(
      `SELECT state FROM generation WHERE id = $1 FOR UPDATE`,
      [input.generationId],
    );
    const generationState = generation.rows[0]?.state ?? 'missing';
    if (generationState === 'succeeded' || generationState === 'failed' || generationState === 'cancelled') {
      await db.query(`UPDATE job SET state = 'done', lease_owner = NULL WHERE id = $1`, [input.jobId]);
      await db.query('COMMIT');
      return { completed: true, reason: 'ALREADY_TERMINAL' };
    }

    if (input.generationState === 'succeeded') {
      await db.query(
        `UPDATE generation SET state = 'succeeded', completed_at = now(), updated_at = now() WHERE id = $1 AND state IN ('queued', 'running')`,
        [input.generationId],
      );
    } else {
      await db.query(
        `UPDATE generation SET state = 'failed', error_code = $2, completed_at = now(), updated_at = now() WHERE id = $1 AND state IN ('queued', 'running')`,
        [input.generationId, input.errorCode ?? 'INTERNAL'],
      );
    }
    await db.query(`UPDATE job SET state = 'done', lease_owner = NULL WHERE id = $1`, [input.jobId]);
    await db.query('COMMIT');
    return { completed: true };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export interface FailureContext {
  jobId: string;
  workerId: string;
  generationId: string;
  reason: string;
  retryable: boolean;
  retryDelaySeconds?: number;
}

/** Records a failure: retryable jobs go back to pending (bounded), others die. */
export async function failJob(
  db: Queryable,
  input: FailureContext,
): Promise<{ retried: boolean; dead: boolean }> {
  await db.query('BEGIN');
  try {
    const job = await db.query<{ lease_owner: string; state: string; attempts: number; max_attempts: number }>(
      `SELECT lease_owner, state, attempts, max_attempts FROM job WHERE id = $1 FOR UPDATE`,
      [input.jobId],
    );
    const row = job.rows[0];
    if (row === undefined || row.state !== 'leased' || row.lease_owner !== input.workerId) {
      await db.query('ROLLBACK');
      return { retried: false, dead: false };
    }
    const exhausted = row.attempts >= row.max_attempts;
    if (!input.retryable || exhausted) {
      await db.query(
        `UPDATE job SET state = 'dead', dead_reason = $2, lease_owner = NULL WHERE id = $1`,
        [input.jobId, input.reason],
      );
      await db.query(
        `UPDATE generation SET state = 'failed', error_code = $2, updated_at = now()
         WHERE id = $1 AND state IN ('queued', 'running')`,
        [input.generationId, input.reason],
      );
      await db.query('COMMIT');
      return { retried: false, dead: true };
    }
    await db.query(
      `UPDATE job SET state = 'pending', lease_owner = NULL, run_after = now() + make_interval(secs => $2)
       WHERE id = $1`,
      [input.jobId, input.retryDelaySeconds ?? 5],
    );
    await db.query('COMMIT');
    return { retried: true, dead: false };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/** Returns expired leases to the pending queue (bounded retry respected). */
export async function reclaimExpiredLeases(db: Queryable): Promise<number> {
  const result = await db.query(
    `UPDATE job SET state = 'pending', lease_owner = NULL, run_after = now()
     WHERE state = 'leased' AND lease_expires_at < now() AND attempts < max_attempts`,
  );
  const dead = await db.query(
    `UPDATE job SET state = 'dead', dead_reason = 'lease_expired_attempts_exhausted', lease_owner = NULL
     WHERE state = 'leased' AND lease_expires_at < now() AND attempts >= max_attempts`,
  );
  return (result.rowCount ?? 0) + (dead.rowCount ?? 0);
}

import type { Queryable } from './queue.js';

/**
 * outcome_unknown handling and reconciliation (J06, architecture §9).
 *
 * Provider timeouts / connection interruptions after a request was sent are
 * NEVER retried automatically and NEVER resolved to failed — the provider may
 * still bill for the work. The generation moves to outcome_unknown, the job
 * dead-letters without regeneration, and an explicit disposition entry point
 * (operator decision or request-ID probe) is the only way forward.
 */

/** Marks a generation outcome_unknown under CAS from queued/running. */
export async function markGenerationOutcomeUnknown(
  db: Queryable,
  input: { generationId: string; attemptId?: string; requestId?: string },
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE generation SET state = 'outcome_unknown', error_code = 'PROVIDER_TIMEOUT_UNKNOWN', updated_at = now()
     WHERE id = $1 AND state IN ('created', 'queued', 'running')`,
    [input.generationId],
  );
  if ((updated.rowCount ?? 0) === 0) {
    return false;
  }
  if (input.attemptId !== undefined) {
    await db.query(
      `UPDATE attempt SET state = 'unknown', provider_request_id = COALESCE($2, provider_request_id), finished_at = now() WHERE id = $1`,
      [input.attemptId, input.requestId ?? null],
    );
  }
  return true;
}

/** Dead-letters a job without touching the generation (CAS on lease owner). */
export async function deadLetterJob(
  db: Queryable,
  input: { jobId: string; workerId: string; reason: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE job SET state = 'dead', dead_reason = $2, lease_owner = NULL
     WHERE id = $1 AND lease_owner = $3 AND state = 'leased'`,
    [input.jobId, input.reason, input.workerId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type UnknownResolution =
  | { resolved: true; state: 'succeeded' | 'failed' }
  | { resolved: false; reason: 'NOT_FOUND' | 'NOT_UNKNOWN' | 'MISSING_REQUEST_ID' };

/**
 * Explicit disposition entry: an operator (or a request-ID probe with real
 * evidence) decides the final state. Without a provider request ID nothing
 * automatic can happen — the task stays outcome_unknown.
 */
export async function resolveUnknown(
  db: Queryable,
  input: {
    generationId: string;
    decision: 'succeeded' | 'failed';
    operatorNote: string;
    requestId?: string;
  },
): Promise<UnknownResolution> {
  const row = (
    await db.query<{ state: string; request_id: string | null }>(
      `SELECT g.state,
              (SELECT a.provider_request_id FROM attempt a
                WHERE a.generation_id = g.id AND a.provider_request_id IS NOT NULL
                ORDER BY a.attempt_no DESC LIMIT 1) AS request_id
       FROM generation g WHERE g.id = $1`,
      [input.generationId],
    )
  ).rows[0];
  if (row === undefined) {
    return { resolved: false, reason: 'NOT_FOUND' };
  }
  if (row.state !== 'outcome_unknown') {
    return { resolved: false, reason: 'NOT_UNKNOWN' };
  }
  if (input.decision === 'succeeded' && row.request_id === null && input.requestId === undefined) {
    // Marking success without provider evidence requires at least a recorded
    // request ID from the acceptance probe; otherwise it stays unknown.
    return { resolved: false, reason: 'MISSING_REQUEST_ID' };
  }
  await db.query(
    `UPDATE generation SET state = $2, error_code = $3, updated_at = now(), completed_at = now() WHERE id = $1`,
    [input.generationId, input.decision, input.decision === 'failed' ? 'PROVIDER_TIMEOUT_UNKNOWN' : null],
  );
  return { resolved: true, state: input.decision };
}

/** Probe hook for request-ID reconciliation; wired to the adapter in W01. */
export async function probeByRequestId(
  db: Queryable,
  input: { generationId: string },
): Promise<{ requestId: string | null }> {
  const row = (
    await db.query<{ request_id: string | null }>(
      `SELECT provider_request_id AS request_id FROM attempt
       WHERE generation_id = $1 AND provider_request_id IS NOT NULL
       ORDER BY attempt_no DESC LIMIT 1`,
      [input.generationId],
    )
  ).rows[0];
  return { requestId: row?.request_id ?? null };
}

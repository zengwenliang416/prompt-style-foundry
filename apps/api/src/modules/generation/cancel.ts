import type { Queryable } from '../../db/queryable.js';

/**
 * Cooperative cancellation (J08, architecture §9 / ADR 0001 D-2).
 *
 * Honesty rules (acceptance):
 * - queued/created: cancelled immediately — nothing was sent, the job row is
 *   removed from the pending queue, and the reserved quota is released;
 * - running: only a cancel REQUEST is recorded (cancel_requested_at); the
 *   answer is CANCEL_NOT_GUARANTEED — the provider may already have accepted
 *   (and bill for) the work, and the allowlisted provider exposes no cancel
 *   API, so nothing upstream is invoked;
 * - outcome_unknown: refusing to cancel — the task must exit via request-ID
 *   reconciliation or operator disposition (J06), not via a user cancel;
 * - terminal states: reported back as-is; a repeated cancel is idempotent
 *   (same outcome, no double quota release — the ledger is unique per
 *   (generation_id, reason)).
 */

export type CancelOutcome = 'cancelled' | 'cancel_requested' | 'already_terminal';

export type CancelResult =
  | { ok: true; outcome: CancelOutcome; state: string; code?: 'CANCEL_NOT_GUARANTEED' }
  | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'GENERATION_STATE_ILLEGAL' };

interface Connectable {
  connect(): Promise<Queryable & { release(): void }>;
}

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

export class CancelService {
  constructor(private readonly pool: Connectable) {}

  async cancel(input: { generationId: string; subjectId: string }): Promise<CancelResult> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      const found = await tx.query<{ owner_id: string; state: string; cancel_requested_at: string | null }>(
        'SELECT owner_id, state, cancel_requested_at FROM generation WHERE id = $1 FOR UPDATE',
        [input.generationId],
      );
      const row = found.rows[0];
      if (row === undefined) {
        await tx.query('ROLLBACK');
        return { ok: false, code: 'NOT_FOUND' };
      }
      if (row.owner_id !== input.subjectId) {
        await tx.query('ROLLBACK');
        return { ok: false, code: 'FORBIDDEN' };
      }

      if (row.state === 'created' || row.state === 'queued') {
        await tx.query(
          `UPDATE generation SET state = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`,
          [input.generationId],
        );
        // Remove the pending job so no worker can ever pick it up.
        await tx.query(
          `UPDATE job SET state = 'dead', dead_reason = 'cancelled', lease_owner = NULL
           WHERE generation_id = $1 AND state = 'pending'`,
          [input.generationId],
        );
        // Never sent → never billed: release the reservation. The ledger's
        // (generation_id, reason) uniqueness makes a repeated cancel a no-op.
        await tx.query(
          `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason) VALUES ($1, $2, +1, 'release')
           ON CONFLICT (generation_id, reason) DO NOTHING`,
          [row.owner_id, input.generationId],
        );
        await tx.query('COMMIT');
        return { ok: true, outcome: 'cancelled', state: 'cancelled' };
      }

      if (row.state === 'running') {
        // Idempotent: a repeated request keeps the original timestamp.
        await tx.query(
          `UPDATE generation SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
           WHERE id = $1`,
          [input.generationId],
        );
        await tx.query('COMMIT');
        return { ok: true, outcome: 'cancel_requested', state: 'running', code: 'CANCEL_NOT_GUARANTEED' };
      }

      await tx.query('ROLLBACK');
      if (TERMINAL_STATES.has(row.state)) {
        return { ok: true, outcome: 'already_terminal', state: row.state };
      }
      // outcome_unknown: user cancel is not a disposition channel.
      return { ok: false, code: 'GENERATION_STATE_ILLEGAL' };
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }
}

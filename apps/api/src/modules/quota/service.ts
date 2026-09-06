import type { Queryable } from '../../db/queryable.js';

/**
 * Quota service (B05, data dictionary §1.12): the quota_ledger is the
 * idempotency anchor — `(generation_id, reason)` unique means a reserve,
 * release, or refund can only ever be recorded once per task.
 *
 * Business rules from ADR 0001 D-2 / §9:
 * - `outcome_unknown` must NEVER auto-release quota (the provider may still
 *   bill for it); release is only legal from `failed` or `cancelled`;
 * - reservations run inside a transaction guarded by a per-subject advisory
 *   lock, so concurrent requests cannot oversubscribe the limit.
 */

export interface QuotaServiceOptions {
  /** Per-subject concurrent generation allowance. */
  limit: number;
}

export type QuotaResult =
  | { ok: true; used: number }
  | { ok: false; code: 'QUOTA_EXCEEDED' | 'ALREADY_RESERVED' | 'ILLEGAL_RELEASE' };

interface PoolLike {
  connect(): Promise<Queryable & { release(): void }>;
  totalCount: number;
}

// pg Client also has connect(); only Pool exposes totalCount.
function isPool(client: Queryable | PoolLike): client is PoolLike {
  return 'totalCount' in client;
}

export class QuotaService {
  /**
   * @param client a pg Client (single-connection use) or a Pool. Transactions
   *   on a Pool check out a dedicated connection, so parallel callers never
   *   interleave BEGIN/COMMIT on the same wire.
   */
  constructor(
    private readonly client: Queryable | PoolLike,
    private readonly options: QuotaOptions,
  ) {}

  async reserve(input: { subjectId: string; generationId: string }): Promise<QuotaResult> {
    return this.runInTransaction(async (tx) => this.reserveWithinTx(tx, input));
  }

  /**
   * Reservation primitive for callers already inside a transaction (J01/J02:
   * generation + job + quota share ONE transaction). Assumes an open tx on
   * `tx` and never commits or rolls back.
   */
  async reserveWithinTx(
    tx: Queryable,
    input: { subjectId: string; generationId: string },
  ): Promise<QuotaResult> {
      // Serialize on the subject so concurrent reserves cannot oversubscribe.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        input.subjectId,
      ]);
      const used = await this.usedIn(tx, input.subjectId);
      if (used >= this.options.limit) {
        return { ok: false as const, code: 'QUOTA_EXCEEDED' as const };
      }
      const insert = await tx.query(
        `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason)
         VALUES ($1, $2, -1, 'reserve') ON CONFLICT (generation_id, reason) DO NOTHING`,
        [input.subjectId, input.generationId],
      );
      if ((insert.rowCount ?? 0) === 0) {
        // Same generation already reserved: idempotent no-charge (J01 replay).
        return { ok: false as const, code: 'ALREADY_RESERVED' as const };
      }
      return { ok: true as const, used: used + 1 };
  }

  async release(input: { subjectId: string; generationId: string }): Promise<QuotaResult> {
    return this.runInTransaction(async (tx) => this.releaseWithinTx(tx, input));
  }

  /** Release primitive for callers already inside a transaction. */
  async releaseWithinTx(
    tx: Queryable,
    input: { subjectId: string; generationId: string },
  ): Promise<QuotaResult> {
    {
      const state = await tx.query<{ state: string }>(
        'SELECT state FROM generation WHERE id = $1 FOR UPDATE',
        [input.generationId],
      );
      const row = state.rows[0];
      if (row === undefined) {
        return { ok: false as const, code: 'ILLEGAL_RELEASE' as const };
      }
      if (row.state === 'outcome_unknown' || row.state === 'succeeded' || row.state === 'running' || row.state === 'queued' || row.state === 'created') {
        // Unknown paid results must not auto-release; succeeded consumed it;
        // in-flight tasks have not reached a terminal billing state.
        return { ok: false as const, code: 'ILLEGAL_RELEASE' as const };
      }
      const insert = await tx.query(
        `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason)
         VALUES ($1, $2, +1, 'release') ON CONFLICT (generation_id, reason) DO NOTHING`,
        [input.subjectId, input.generationId],
      );
      if ((insert.rowCount ?? 0) === 0) {
        return { ok: false as const, code: 'ALREADY_RESERVED' as const };
      }
      const used = await this.usedIn(tx, input.subjectId);
      return { ok: true as const, used };
    }
  }

  /** Running/queued generation count for the concurrency limit. */
  async activeGenerations(subjectId: string): Promise<number> {
    // A Pool satisfies Queryable structurally for plain queries.
    const db: Queryable = this.client as Queryable;
    const result = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM generation
       WHERE owner_id = $1 AND state IN ('created', 'queued', 'running')`,
      [subjectId],
    );
    return Number.parseInt(result.rows[0]!.n, 10);
  }

  private async usedIn(tx: Queryable, subjectId: string): Promise<number> {
    const result = await tx.query<{ used: string }>(
      'SELECT COALESCE(-SUM(delta), 0)::text AS used FROM quota_ledger WHERE subject_id = $1',
      [subjectId],
    );
    return Number.parseInt(result.rows[0]!.used, 10);
  }

  private async runInTransaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (isPool(this.client)) {
      const connection = await this.client.connect();
      try {
        await connection.query('BEGIN');
        const outcome = await work(connection);
        await connection.query('COMMIT');
        return outcome;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
    const client = this.client;
    await client.query('BEGIN');
    try {
      const outcome = await work(client);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

export interface QuotaOptions {
  limit: number;
}

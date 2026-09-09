import type { Queryable } from '../../db/queryable.js';
import type { StoragePort } from '../../infra/storage/storage.js';

/**
 * User-initiated deletion (O01). Deletion never rewrites history: the
 * generation/attempt/result metadata and hash fact rows stay in place (the
 * generation state enum has no 'deleted' value and the query layer already
 * renders deleted media as history-preserved with no download URL). What
 * actually happens:
 *
 * - object-level authorization first (missing → NOT_FOUND, cross-user →
 *   FORBIDDEN);
 * - created/queued generations are cancelled in-place first (J08 semantics:
 *   job removed from the pending queue, quota reservation released once);
 * - running generations get a cancel request recorded (CANCEL_NOT_GUARANTEED —
 *   the provider may already bill); nothing upstream is invoked;
 * - outcome_unknown refuses deletion (409) — evidence for reconciliation must
 *   not be destroyed;
 * - the result media (if any) and the input media (when no other generation
 *   references it) transition to 'expired' and are physically purged
 *   immediately: storage bytes removed, deletion_manifest row written with
 *   reason 'user_delete', state='deleted'. A storage failure leaves the media
 *   'expired' so the retention sweep retries the purge;
 * - repeated deletes are idempotent (same outcome, manifest never duplicated).
 */

export type DeleteResult =
  | { ok: true; state: string; code?: 'CANCEL_NOT_GUARANTEED' }
  | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'GENERATION_STATE_ILLEGAL' };

interface Connectable {
  connect(): Promise<Queryable & { release(): void }>;
}

export class DeleteService {
  constructor(
    private readonly pool: Queryable & Connectable,
    private readonly storage: StoragePort,
  ) {}

  async delete(input: { generationId: string; subjectId: string }): Promise<DeleteResult> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      const found = await tx.query<{ owner_id: string; state: string; input_object_id: string }>(
        'SELECT owner_id, state, input_object_id FROM generation WHERE id = $1 FOR UPDATE',
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
      if (row.state === 'outcome_unknown') {
        await tx.query('ROLLBACK');
        // Reconciliation evidence must survive (J06): no user deletion.
        return { ok: false, code: 'GENERATION_STATE_ILLEGAL' };
      }

      let code: 'CANCEL_NOT_GUARANTEED' | undefined;
      let state = row.state;
      if (row.state === 'created' || row.state === 'queued') {
        await tx.query(
          `UPDATE generation SET state = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`,
          [input.generationId],
        );
        await tx.query(
          `UPDATE job SET state = 'dead', dead_reason = 'cancelled', lease_owner = NULL
           WHERE generation_id = $1 AND state = 'pending'`,
          [input.generationId],
        );
        await tx.query(
          `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason) VALUES ($1, $2, +1, 'release')
           ON CONFLICT (generation_id, reason) DO NOTHING`,
          [row.owner_id, input.generationId],
        );
        state = 'cancelled';
      } else if (row.state === 'running') {
        await tx.query(
          `UPDATE generation SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
           WHERE id = $1`,
          [input.generationId],
        );
        code = 'CANCEL_NOT_GUARANTEED';
      }

      // Media entering the deletion channel: the result media (if one exists
      // and is still live) plus the input media when no OTHER generation
      // still references it.
      const media = (
        await tx.query<{ id: string }>(
          `SELECT m.id FROM media_object m
           WHERE m.state IN ('ready', 'quarantine') AND (
             m.id = (SELECT r.media_object_id FROM result r WHERE r.generation_id = $1)
             OR (
               m.id = $2 AND NOT EXISTS (
                 SELECT 1 FROM generation other
                 WHERE other.input_object_id = $2 AND other.id <> $1
               )
             )
           )`,
          [input.generationId, row.input_object_id],
        )
      ).rows.map((r) => r.id);
      if (media.length > 0) {
        await tx.query(
          `UPDATE media_object SET state = 'expired' WHERE id = ANY($1) AND state IN ('ready', 'quarantine')`,
          [media],
        );
      }
      await tx.query('COMMIT');

      // Physical purge after commit, in the same byte → manifest → state
      // order as the worker retention sweep (architecture §4 forbids sharing
      // code across the app boundary, so the sequence is explicit here):
      // bytes first; the manifest row + state='deleted' only after the remove
      // succeeds. A storage failure leaves the media 'expired' so the
      // retention sweep retries the purge; the guarded manifest insert keeps
      // that retry from duplicating rows.
      for (const id of media) {
        const target = (
          await this.pool.query<{ bucket: string; object_key: string }>(
            `SELECT bucket, object_key FROM media_object WHERE id = $1 AND state = 'expired'`,
            [id],
          )
        ).rows[0];
        if (target === undefined) {
          continue;
        }
        try {
          await this.storage.remove({ bucket: target.bucket, key: target.object_key });
        } catch {
          continue;
        }
        await this.pool.query(
          `INSERT INTO deletion_manifest (media_object_id, reason)
           SELECT $1, 'user_delete'
           WHERE NOT EXISTS (SELECT 1 FROM deletion_manifest WHERE media_object_id = $1)`,
          [id],
        );
        await this.pool.query(
          `UPDATE media_object SET state = 'deleted' WHERE id = $1 AND state = 'expired'`,
          [id],
        );
      }
      return { ok: true, state, ...(code !== undefined ? { code } : {}) };
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }
}

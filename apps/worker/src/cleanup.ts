import type { Queryable } from './queue.js';

/**
 * Retention and deletion flows (O01, data dictionary §3, ADR 0001 D-2).
 *
 * One sweep is idempotent and ordered so a single run never deletes media it
 * just expired in the same pass:
 *
 *   1. physically purge media already in state 'expired' (storage bytes first,
 *      deletion_manifest row + state='deleted' only after the remove succeeds;
 *      a storage failure leaves the row 'expired' for the next sweep and is
 *      reported in `failures` — repeated sweeps never duplicate manifest rows);
 *   2. expire newly due media (incomplete uploads, terminal input media, due
 *      result media) and transition their succeeded generations to 'expired';
 *   3. prune terminal task rows past the task retention window;
 *   4. prune audit events past the audit retention window.
 *
 * In-flight and unknown tasks are protected structurally: media referenced by
 * a generation in created/queued/running/outcome_unknown is never expired or
 * pruned, and outcome_unknown/succeeded generations are never row-pruned.
 * Expiry never rewrites history — attempt/result metadata and hashes survive
 * until the task retention window ends.
 *
 * The API's user-deletion flow (apps/api/src/modules/generation/delete.ts)
 * performs the same byte-then-manifest-then-state purge inline; architecture
 * §4 forbids sharing code across the app boundary, so both sides keep the
 * sequence explicitly in this exact order.
 */

/** Structural storage port — only removal is needed for retention. */
export interface MediaRemover {
  remove(input: { bucket: string; key: string }): Promise<void>;
}

export interface RetentionPolicy {
  /** Incomplete (unconfirmed) upload sessions, hours. Default 1. */
  uploadIncompleteHours: number;
  /** Input media after its generations all reached a terminal state, hours. Default 24. */
  inputMediaHours: number;
  /** Result media after creation, days. Default 7. */
  resultMediaDays: number;
  /** Task rows + prompt hash facts after terminal completion, days. Default 30. */
  generationDays: number;
  /** Redacted audit events, days. Default 90. */
  auditEventDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  uploadIncompleteHours: 1,
  inputMediaHours: 24,
  resultMediaDays: 7,
  generationDays: 30,
  auditEventDays: 90,
};

/** States in which a generation still needs its input/result media intact. */
const PROTECTED_STATES = ['created', 'queued', 'running', 'outcome_unknown'] as const;

/** Terminal states eligible for row pruning after the task retention window. */
const PRUNABLE_STATES = ['failed', 'cancelled', 'expired'] as const;

export interface MediaPurgeFailure {
  mediaObjectId: string;
  reason: string;
}

export interface CleanupReport {
  expiredUploads: number;
  expiredInputs: number;
  expiredResults: number;
  transitionedGenerations: number;
  deletedMedia: number;
  prunedGenerations: number;
  prunedAuditEvents: number;
  failures: MediaPurgeFailure[];
}

export interface MediaPurgeOutcome {
  deleted: string[];
  failures: MediaPurgeFailure[];
}

/**
 * Physically deletes the given media objects: storage bytes first; only after
 * the remove succeeds is the deletion_manifest row written and the object
 * marked 'deleted'. The manifest insert is guarded so repeated purges of the
 * same object never create duplicate rows; the state CAS makes a second purge
 * a no-op. Storage failures are reported and leave the row untouched so the
 * next sweep retries.
 */
export async function purgeMediaObjects(
  db: Queryable,
  storage: MediaRemover,
  mediaObjectIds: readonly string[],
  reason: 'retention' | 'user_delete',
): Promise<MediaPurgeOutcome> {
  const deleted: string[] = [];
  const failures: MediaPurgeFailure[] = [];
  for (const id of mediaObjectIds) {
    const row = (
      await db.query<{ bucket: string; object_key: string; state: string }>(
        'SELECT bucket, object_key, state FROM media_object WHERE id = $1',
        [id],
      )
    ).rows[0];
    if (row === undefined || row.state !== 'expired') {
      continue;
    }
    try {
      await storage.remove({ bucket: row.bucket, key: row.object_key });
    } catch (error) {
      failures.push({
        mediaObjectId: id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    await db.query(
      `INSERT INTO deletion_manifest (media_object_id, reason)
       SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM deletion_manifest WHERE media_object_id = $1)`,
      [id, reason],
    );
    const updated = await db.query(
      `UPDATE media_object SET state = 'deleted' WHERE id = $1 AND state = 'expired'`,
      [id],
    );
    if ((updated.rowCount ?? 0) > 0) {
      deleted.push(id);
    }
  }
  return { deleted, failures };
}

export class CleanupService {
  private readonly policy: RetentionPolicy;
  private readonly now: () => Date;

  constructor(
    private readonly db: Queryable,
    private readonly storage: MediaRemover,
    policy: RetentionPolicy,
    now?: () => Date,
  ) {
    for (const [field, value] of Object.entries(policy)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`retention policy ${field} must be a positive integer`);
      }
    }
    this.policy = policy;
    this.now = now ?? (() => new Date());
  }

  async sweep(): Promise<CleanupReport> {
    const now = this.now();
    const report: CleanupReport = {
      expiredUploads: 0,
      expiredInputs: 0,
      expiredResults: 0,
      transitionedGenerations: 0,
      deletedMedia: 0,
      prunedGenerations: 0,
      prunedAuditEvents: 0,
      failures: [],
    };

    // 1. Purge media that entered the deletion channel before this sweep.
    const expiredRows = (
      await this.db.query<{ id: string }>(
        `SELECT id FROM media_object WHERE state = 'expired' ORDER BY created_at`,
      )
    ).rows;
    const purged = await purgeMediaObjects(
      this.db,
      this.storage,
      expiredRows.map((r) => r.id),
      'retention',
    );
    report.deletedMedia = purged.deleted.length;
    report.failures.push(...purged.failures);

    // 2a. Incomplete upload sessions: never confirmed within the upload window.
    const uploadCutoff = new Date(now.getTime() - this.policy.uploadIncompleteHours * 3_600_000);
    report.expiredUploads =
      (
        await this.db.query(
          `UPDATE media_object m SET state = 'expired'
           FROM upload u
           WHERE u.media_object_id = m.id
             AND u.confirmed_at IS NULL
             AND m.state = 'quarantine'
             AND u.created_at < $1`,
          [uploadCutoff],
        )
      ).rowCount ?? 0;

    // 2b. Input media: 24h after every referencing generation went terminal.
    // Generations still in flight (or outcome_unknown) protect the media; an
    // input never referenced by a generation falls back to its confirm time.
    const inputCutoff = new Date(now.getTime() - this.policy.inputMediaHours * 3_600_000);
    report.expiredInputs =
      (
        await this.db.query(
          `UPDATE media_object m SET state = 'expired'
           WHERE m.kind = 'input' AND m.state = 'ready'
             AND NOT EXISTS (
               SELECT 1 FROM generation g
               WHERE g.input_object_id = m.id AND g.state = ANY($2)
             )
             AND COALESCE(
                   (SELECT max(g.completed_at) FROM generation g WHERE g.input_object_id = m.id),
                   (SELECT u.confirmed_at FROM upload u WHERE u.media_object_id = m.id),
                   m.created_at
                 ) < $1`,
          [inputCutoff, [...PROTECTED_STATES]],
        )
      ).rowCount ?? 0;

    // 2c. Result media past its expiry; the owning succeeded generation
    // transitions to 'expired' (ADR 0001 D-2) — history rows stay untouched.
    report.expiredResults =
      (
        await this.db.query(
          `UPDATE media_object m SET state = 'expired'
           WHERE m.kind = 'result' AND m.state = 'ready' AND m.expires_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM result r JOIN generation g ON g.id = r.generation_id
               WHERE r.media_object_id = m.id AND g.state = ANY($2)
             )`,
          [now, [...PROTECTED_STATES]],
        )
      ).rowCount ?? 0;
    report.transitionedGenerations =
      (
        await this.db.query(
          `UPDATE generation g SET state = 'expired', updated_at = now()
           WHERE g.state = 'succeeded'
             AND EXISTS (
               SELECT 1 FROM result r JOIN media_object m ON m.id = r.media_object_id
               WHERE r.generation_id = g.id AND m.state IN ('expired', 'deleted')
             )`,
        )
      ).rowCount ?? 0;

    // 3. Prune terminal task rows past the task retention window. Children
    // first (result -> attempt/job/quota_ledger -> generation); a live job
    // lease blocks pruning. outcome_unknown and succeeded are never pruned.
    const generationCutoff = new Date(now.getTime() - this.policy.generationDays * 86_400_000);
    report.prunedGenerations = await this.pruneGenerations(generationCutoff);

    // 4. Audit events past the audit retention window.
    const auditCutoff = new Date(now.getTime() - this.policy.auditEventDays * 86_400_000);
    report.prunedAuditEvents =
      (await this.db.query('DELETE FROM audit_event WHERE created_at < $1', [auditCutoff]))
        .rowCount ?? 0;

    return report;
  }

  private async pruneGenerations(cutoff: Date): Promise<number> {
    const doomed = (
      await this.db.query<{ id: string }>(
        `SELECT g.id FROM generation g
         WHERE g.state = ANY($1) AND g.completed_at < $2
           AND NOT EXISTS (
             SELECT 1 FROM job j
             WHERE j.generation_id = g.id AND j.state IN ('pending', 'leased')
           )
         ORDER BY g.completed_at`,
        [[...PRUNABLE_STATES], cutoff],
      )
    ).rows.map((r) => r.id);
    if (doomed.length === 0) {
      return 0;
    }
    await this.db.query('DELETE FROM result WHERE generation_id = ANY($1)', [doomed]);
    await this.db.query('DELETE FROM attempt WHERE generation_id = ANY($1)', [doomed]);
    await this.db.query('DELETE FROM job WHERE generation_id = ANY($1)', [doomed]);
    await this.db.query('DELETE FROM quota_ledger WHERE generation_id = ANY($1)', [doomed]);
    const removed = await this.db.query('DELETE FROM generation WHERE id = ANY($1)', [doomed]);
    return removed.rowCount ?? 0;
  }
}

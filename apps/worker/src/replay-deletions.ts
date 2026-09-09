import type { StoragePort } from '@onepic/managed-runtime';

import type { Queryable } from './queue.js';

export interface DeletionReplayFailure {
  mediaObjectId: string;
  reason: string;
}

export interface DeletionReplayReport {
  dryRun: boolean;
  scanned: number;
  removalAttempts: number;
  batches: number;
  failures: DeletionReplayFailure[];
}

export interface DeletionReplayOptions {
  apply?: boolean;
  batchSize?: number;
}

interface ManifestObject extends Record<string, unknown> {
  id: string;
  bucket: string;
  object_key: string;
}

/**
 * Replays the durable deletion channel after an object-store restore.
 *
 * Only media already committed as `deleted` and referenced by
 * `deletion_manifest` is eligible. The default is a side-effect-free dry run;
 * callers must explicitly set `apply: true`. Storage deletion must be
 * idempotent (S3 DELETE and LocalDiskStorage.remove both satisfy this), so the
 * whole replay can be repeated after interruption.
 */
export async function replayDeletionManifest(
  db: Queryable,
  storage: Pick<StoragePort, 'remove'>,
  options: DeletionReplayOptions = {},
): Promise<DeletionReplayReport> {
  const apply = options.apply ?? false;
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error('deletion replay batchSize must be an integer from 1 to 5000');
  }

  const report: DeletionReplayReport = {
    dryRun: !apply,
    scanned: 0,
    removalAttempts: 0,
    batches: 0,
    failures: [],
  };
  let cursor: string | null = null;

  for (;;) {
    const rows: ManifestObject[] = (
      await db.query<ManifestObject>(
        `SELECT m.id, m.bucket, m.object_key
           FROM deletion_manifest d
           JOIN media_object m ON m.id = d.media_object_id
          WHERE m.state = 'deleted'
            AND ($1::uuid IS NULL OR m.id > $1::uuid)
          GROUP BY m.id, m.bucket, m.object_key
          ORDER BY m.id
          LIMIT $2`,
        [cursor, batchSize],
      )
    ).rows;
    if (rows.length === 0) break;
    report.batches += 1;
    report.scanned += rows.length;

    if (apply) {
      for (const row of rows) {
        report.removalAttempts += 1;
        try {
          await storage.remove({ bucket: row.bucket, key: row.object_key });
        } catch (error) {
          report.failures.push({
            mediaObjectId: row.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    cursor = rows.at(-1)!.id;
  }

  return report;
}

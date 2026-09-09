import { describe, expect, it, vi } from 'vitest';

import { replayDeletionManifest } from './replay-deletions.js';
import type { Queryable } from './queue.js';

const id1 = '00000000-0000-0000-0000-000000000001';
const id2 = '00000000-0000-0000-0000-000000000002';

function pagedDb() {
  const pages = [
    [{ id: id1, bucket: 'private', object_key: 'one.webp' }],
    [{ id: id2, bucket: 'private', object_key: 'two.webp' }],
    [],
  ];
  return {
    query: vi.fn(async () => ({ rows: pages.shift() ?? [], rowCount: 0 })),
  } as unknown as Queryable;
}

describe('replayDeletionManifest', () => {
  it('defaults to dry-run and paginates without removing bytes', async () => {
    const remove = vi.fn(async () => undefined);
    const report = await replayDeletionManifest(pagedDb(), { remove }, { batchSize: 1 });
    expect(report).toMatchObject({ dryRun: true, scanned: 2, removalAttempts: 0, batches: 2 });
    expect(report.failures).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('applies idempotent removals and reports failures without aborting the replay', async () => {
    const remove = vi
      .fn<(input: { bucket: string; key: string }) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('storage unavailable'));
    const report = await replayDeletionManifest(
      pagedDb(),
      { remove },
      { apply: true, batchSize: 1 },
    );
    expect(report).toMatchObject({ dryRun: false, scanned: 2, removalAttempts: 2, batches: 2 });
    expect(report.failures).toEqual([{ mediaObjectId: id2, reason: 'storage unavailable' }]);
  });

  it.each([0, 1.5, 5_001])('rejects unsafe batch size %s', async (batchSize) => {
    await expect(
      replayDeletionManifest(pagedDb(), { remove: vi.fn() }, { batchSize }),
    ).rejects.toThrow('batchSize');
  });
});

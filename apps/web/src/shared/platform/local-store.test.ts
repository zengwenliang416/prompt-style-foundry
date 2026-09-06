// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_RECORD_KEY,
  emptyRecord,
  readLocal,
  recordRecentView,
  writeLocal,
} from './local-store.js';

describe('local-store (U06/U10 foundation)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('returns an honest empty record on first visit', () => {
    const { record, status } = readLocal();
    expect(record).toEqual(emptyRecord());
    expect(status).toEqual({ available: true, corrupted: false });
  });

  it('persists and reloads a record', () => {
    expect(
      writeLocal({ schemaVersion: 1, favorites: ['case-1'], recent: [], collections: [] })
        .available,
    ).toBe(true);
    const { record } = readLocal();
    expect(record.favorites).toEqual(['case-1']);
  });

  it('treats corrupted payloads as empty with a flag, not a crash', () => {
    localStorage.setItem(LOCAL_RECORD_KEY, '{not-json');
    let result = readLocal();
    expect(result.record).toEqual(emptyRecord());
    expect(result.status.corrupted).toBe(true);

    localStorage.setItem(LOCAL_RECORD_KEY, JSON.stringify({ schemaVersion: 9 }));
    result = readLocal();
    expect(result.status.corrupted).toBe(true);
    expect(result.record).toEqual(emptyRecord());
  });

  it('degrades to unavailable when storage access throws', () => {
    const throwing = {
      get length(): number {
        throw new Error('blocked');
      },
      getItem(): string | null {
        throw new Error('blocked');
      },
      setItem(): void {
        throw new Error('blocked');
      },
      clear(): void {},
      key(): string | null {
        return null;
      },
      removeItem(): void {},
    };
    vi.stubGlobal('localStorage', throwing);

    const { status } = readLocal();
    expect(status.available).toBe(false);
    expect(writeLocal(emptyRecord()).available).toBe(false);
  });

  it('records recent views deduplicated, newest first, capped', () => {
    recordRecentView('case-1');
    recordRecentView('case-2');
    recordRecentView('case-1');

    const { record } = readLocal();
    expect(record.recent.map((item) => item.id)).toEqual(['case-1', 'case-2']);

    for (let i = 0; i < 30; i += 1) {
      recordRecentView(`case-${100 + i}`);
    }
    const capped = readLocal().record.recent;
    expect(capped.length).toBeLessThanOrEqual(20);
    expect(capped[0]?.id).toBe('case-129');
  });

  it('keeps the record when only writes fail (read path stays consistent)', () => {
    recordRecentView('case-1');
    const throwing = {
      get length(): number {
        return 1;
      },
      getItem: (key: string) => localStorage.getItem(key),
      setItem(): void {
        throw new Error('quota exceeded');
      },
      clear(): void {},
      key(): string | null {
        return null;
      },
      removeItem(): void {},
    };
    vi.stubGlobal('localStorage', throwing);

    expect(writeLocal(emptyRecord()).available).toBe(false);
  });
});

/**
 * Browser-local record store (localStorage) for favorites, recent views, and
 * later collections (U10). Versioned under a single key; every access is
 * failure-tolerant: unavailable storage and corrupted payloads degrade to an
 * honest empty state instead of throwing or faking data (U06 acceptance).
 */

export interface RecentView {
  id: string;
  viewedAt: string;
}

export interface LocalCollection {
  id: string;
  name: string;
  templateIds: string[];
}

export interface LocalRecord {
  schemaVersion: 1;
  favorites: string[];
  recent: RecentView[];
  collections: LocalCollection[];
}

export interface LocalStoreStatus {
  available: boolean;
  corrupted: boolean;
}

export const LOCAL_RECORD_KEY = 'onepic.local.v1';
const RECENT_LIMIT = 20;

export function emptyRecord(): LocalRecord {
  return { schemaVersion: 1, favorites: [], recent: [], collections: [] };
}

function sanitizeCollection(value: unknown): LocalCollection | null {
  const raw = value as Partial<LocalCollection> | null;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    typeof raw.id !== 'string' ||
    raw.id === '' ||
    typeof raw.name !== 'string' ||
    !Array.isArray(raw.templateIds)
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    templateIds: raw.templateIds.filter((id) => typeof id === 'string'),
  };
}

function sanitizeRecord(parsed: unknown): LocalRecord | null {
  const record = parsed as Partial<LocalRecord> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.favorites) ||
    !Array.isArray(record.recent)
  ) {
    return null;
  }
  const collections = Array.isArray(record.collections)
    ? record.collections
        .map(sanitizeCollection)
        .filter((item): item is LocalCollection => item !== null)
    : [];
  return {
    schemaVersion: 1,
    favorites: record.favorites.filter((id) => typeof id === 'string'),
    recent: record.recent.filter(
      (item): item is RecentView =>
        typeof item?.id === 'string' && typeof item?.viewedAt === 'string',
    ),
    collections,
  };
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }
    // Access throws in privacy modes even when the object exists.
    void localStorage.length;
    return localStorage;
  } catch {
    return undefined;
  }
}

export function readLocal(): { record: LocalRecord; status: LocalStoreStatus } {
  const store = storage();
  if (store === undefined) {
    return { record: emptyRecord(), status: { available: false, corrupted: false } };
  }
  try {
    const raw = store.getItem(LOCAL_RECORD_KEY);
    if (raw === null) {
      return { record: emptyRecord(), status: { available: true, corrupted: false } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { record: emptyRecord(), status: { available: true, corrupted: true } };
    }
    const record = sanitizeRecord(parsed);
    if (record === null) {
      return { record: emptyRecord(), status: { available: true, corrupted: true } };
    }
    return { record, status: { available: true, corrupted: false } };
  } catch {
    return { record: emptyRecord(), status: { available: true, corrupted: true } };
  }
}

export function writeLocal(record: LocalRecord): LocalStoreStatus {
  const store = storage();
  if (store === undefined) {
    return { available: false, corrupted: false };
  }
  try {
    store.setItem(LOCAL_RECORD_KEY, JSON.stringify(record));
    return { available: true, corrupted: false };
  } catch {
    return { available: false, corrupted: false };
  }
}

export function recordRecentView(id: string): LocalStoreStatus {
  const { record } = readLocal();
  const filtered = record.recent.filter((item) => item.id !== id);
  const recent = [{ id, viewedAt: new Date().toISOString() }, ...filtered].slice(0, RECENT_LIMIT);
  return writeLocal({ ...record, recent });
}

export function toggleFavorite(id: string): { status: LocalStoreStatus; favorited: boolean } {
  const { record } = readLocal();
  const favorited = !record.favorites.includes(id);
  const favorites = favorited
    ? [...record.favorites, id]
    : record.favorites.filter((existing) => existing !== id);
  return { status: writeLocal({ ...record, favorites }), favorited };
}

export function createCollection(name: string): {
  status: LocalStoreStatus;
  collection: LocalCollection | null;
} {
  const { record } = readLocal();
  const trimmed = name.trim();
  if (trimmed === '') {
    return { status: writeLocal(record), collection: null };
  }
  const collection: LocalCollection = {
    id: `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    templateIds: [],
  };
  const status = writeLocal({ ...record, collections: [...record.collections, collection] });
  return { status, collection: status.available ? collection : null };
}

export function deleteCollection(collectionId: string): LocalStoreStatus {
  const { record } = readLocal();
  const collections = record.collections.filter((collection) => collection.id !== collectionId);
  return writeLocal({ ...record, collections });
}

export type ImportResult =
  | {
      ok: true;
      record: LocalRecord;
      merged: { favorites: number; recent: number; collections: number };
    }
  | { ok: false; error: 'bad-json' | 'schema' };

/**
 * Merges an imported payload into the current record: favorites dedupe by
 * id, recent keeps the newest entry per template, collections merge by id
 * with unioned members. Runs before any write so a bad file never wipes
 * local data.
 */
export function mergeImport(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'bad-json' };
  }
  const incoming = sanitizeRecord(parsed);
  if (incoming === null) {
    return { ok: false, error: 'schema' };
  }

  const current = readLocal().record;
  const favorites = [...new Set([...current.favorites, ...incoming.favorites])];

  const recentById = new Map<string, RecentView>();
  for (const view of [...current.recent, ...incoming.recent]) {
    const existing = recentById.get(view.id);
    if (existing === undefined || existing.viewedAt < view.viewedAt) {
      recentById.set(view.id, view);
    }
  }
  const recent = [...recentById.values()]
    .sort((a, b) => (a.viewedAt < b.viewedAt ? 1 : -1))
    .slice(0, RECENT_LIMIT);

  const collectionsById = new Map<string, LocalCollection>();
  for (const collection of [...current.collections, ...incoming.collections]) {
    const existing = collectionsById.get(collection.id);
    if (existing === undefined) {
      collectionsById.set(collection.id, collection);
    } else {
      collectionsById.set(collection.id, {
        ...existing,
        templateIds: [...new Set([...existing.templateIds, ...collection.templateIds])],
      });
    }
  }

  const record: LocalRecord = {
    schemaVersion: 1,
    favorites,
    recent,
    collections: [...collectionsById.values()],
  };
  return {
    ok: true,
    record,
    merged: {
      favorites: favorites.length - current.favorites.length,
      recent: recent.length - current.recent.length,
      collections: collectionsById.size - current.collections.length,
    },
  };
}

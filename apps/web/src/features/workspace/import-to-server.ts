import { ApiRequestError, type OnePicClient } from '@onepic/client';
import type { CollectionSummary } from '@onepic/contracts';

import { validateLocalRecord, type LocalRecord } from '../../shared/platform/local-store.js';

/**
 * Explicit local→server import (W04).
 *
 * The flow is user-triggered only — nothing here runs automatically. The
 * request whitelist is strict by construction: bodies contain ONLY
 * `{ name }` (create collection) and `{ itemType, itemKey }` (add item);
 * the BYOK key, BYOK endpoint/model/quality settings, recent views, and any
 * other local field never leave the browser.
 *
 * Mapping (the server has no bare favorites concept — §1.13 favorites live
 * inside collections):
 * - local favorites → a stable collection named 导入的收藏;
 * - each local collection → a server collection of the same name.
 *
 * Idempotency: collection creation answers 409 on a name conflict, in which
 * case the existing collection (found by paging GET /collections) is reused;
 * item adds are PK-idempotent server-side. New-vs-skipped item counts are
 * derived honestly from the collection itemCount delta around the adds, so
 * a repeated import reports 0 new without the add-item response having to
 * distinguish replays (keeps the W03 "identical response" contract intact).
 *
 * Partial failure never aborts the run: every failed collection/item lands
 * in `failures` with its stable error code, and the rest continue.
 */

export const IMPORTED_FAVORITES_COLLECTION = '导入的收藏';

const TEMPLATE_ID_RE = /^(case-[0-9]+|framework-[0-9]{3})$/;

export interface ServerImportFailure {
  /** Collection name, or `集合名/条目` for item failures. */
  label: string;
  /** Stable API error code (never the human message). */
  reason: string;
}

export interface ServerImportReport {
  collectionsNew: number;
  collectionsExisting: number;
  itemsNew: number;
  itemsSkipped: number;
  itemsFailed: number;
  failures: ServerImportFailure[];
}

export type ServerImportResult =
  | { ok: true; report: ServerImportReport }
  | { ok: false; error: 'invalid-record' | 'unauthenticated' | 'unavailable'; reason?: string };

interface PlannedCollection {
  name: string;
  itemKeys: string[];
}

function plan(record: LocalRecord): PlannedCollection[] {
  const favorites = [...new Set(record.favorites.filter((id) => TEMPLATE_ID_RE.test(id)))];
  const planned: PlannedCollection[] = [];
  if (favorites.length > 0) {
    planned.push({ name: IMPORTED_FAVORITES_COLLECTION, itemKeys: favorites });
  }
  for (const collection of record.collections) {
    const name = collection.name.trim();
    if (name === '') {
      continue;
    }
    planned.push({
      name,
      itemKeys: [...new Set(collection.templateIds.filter((id) => TEMPLATE_ID_RE.test(id)))],
    });
  }
  return planned;
}

async function findCollectionByName(
  client: OnePicClient,
  name: string,
): Promise<{ id: string; itemCount: number } | null> {
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listCollections(cursor === undefined ? {} : { cursor });
    const found = page.data.items?.find((item: CollectionSummary) => item.name === name);
    if (found !== undefined && found.id !== undefined) {
      return { id: found.id, itemCount: found.itemCount ?? 0 };
    }
    const next = page.meta?.nextCursor;
    if (typeof next !== 'string') {
      return null;
    }
    cursor = next;
  }
}

async function ensureCollection(
  client: OnePicClient,
  name: string,
): Promise<{ id: string; itemCount: number; created: boolean }> {
  try {
    const created = await client.createCollection({ name });
    return { id: created.id ?? '', itemCount: created.itemCount ?? 0, created: true };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      const existing = await findCollectionByName(client, name);
      if (existing === null) {
        throw new ApiRequestError(409, 'COLLECTION_NAME_CONFLICT', 'conflict but not listable');
      }
      return { ...existing, created: false };
    }
    throw error;
  }
}

function errorReason(error: unknown): string {
  return error instanceof ApiRequestError ? error.code : 'NETWORK_ERROR';
}

export async function importRecordToServer(
  client: OnePicClient,
  source: unknown,
): Promise<ServerImportResult> {
  // The same schema validation as the local import path runs before any
  // request is constructed — a corrupted record never reaches the network.
  const record = validateLocalRecord(source);
  if (record === null) {
    return { ok: false, error: 'invalid-record' };
  }

  const report: ServerImportReport = {
    collectionsNew: 0,
    collectionsExisting: 0,
    itemsNew: 0,
    itemsSkipped: 0,
    itemsFailed: 0,
    failures: [],
  };

  for (const collection of plan(record)) {
    let ensured: { id: string; itemCount: number; created: boolean };
    try {
      ensured = await ensureCollection(client, collection.name);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        return { ok: false, error: 'unauthenticated', reason: error.code };
      }
      report.failures.push({ label: collection.name, reason: errorReason(error) });
      continue;
    }
    if (ensured.created) {
      report.collectionsNew += 1;
    } else {
      report.collectionsExisting += 1;
    }

    let succeeded = 0;
    for (const itemKey of collection.itemKeys) {
      try {
        await client.addCollectionItem(ensured.id, { itemType: 'template', itemKey });
        succeeded += 1;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          return { ok: false, error: 'unauthenticated', reason: error.code };
        }
        report.itemsFailed += 1;
        report.failures.push({
          label: `${collection.name}/${itemKey}`,
          reason: errorReason(error),
        });
      }
    }

    // New-vs-skipped from the server-visible itemCount delta (idempotent
    // replays do not move the count).
    try {
      const after = await findCollectionByName(client, collection.name);
      const delta = after === null ? succeeded : Math.max(after.itemCount - ensured.itemCount, 0);
      report.itemsNew += delta;
      report.itemsSkipped += succeeded - delta;
    } catch {
      // The recount is best-effort: items are safely stored either way, so
      // count successes as new and note the uncertainty.
      report.itemsNew += succeeded;
      report.failures.push({ label: collection.name, reason: 'RECOUNT_UNAVAILABLE' });
    }
  }

  return { ok: true, report };
}

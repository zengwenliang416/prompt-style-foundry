import { describe, expect, it } from 'vitest';

import { createOnePicClient } from '@onepic/client';

import { importRecordToServer, IMPORTED_FAVORITES_COLLECTION } from './import-to-server.js';
import type { LocalRecord } from '../../shared/platform/local-store.js';

/**
 * W04 web-side import acceptance. The HTTP boundary is a stateful fake
 * server (collections + PK-idempotent items, name-conflict 409, optional
 * per-item 404) so idempotency and partial-failure behavior are exercised
 * against realistic response semantics.
 */

interface FakeServer {
  calls: Array<{ url: string; method: string; body: unknown }>;
  collections: Map<string, { id: string; itemCount: number }>;
  items: Map<string, Set<string>>;
  failItemKeys: Set<string>;
  sequence: number;
}

function startFakeServer(options: { failItemKeys?: string[] } = {}): FakeServer {
  return {
    calls: [],
    collections: new Map(),
    items: new Map(),
    failItemKeys: new Set(options.failItemKeys ?? []),
    sequence: 0,
  };
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code, correlationId: 'c-1' } }), {
    status,
  });
}

function fakeFetch(server: FakeServer): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    server.calls.push({ url: url.pathname + url.search, method, body });

    if (url.pathname === '/api/v1/collections' && method === 'GET') {
      const items = [...server.collections.entries()].map(([name, c]) => ({
        id: c.id,
        name,
        createdAt: '2026-09-07T00:00:00.000Z',
        itemCount: c.itemCount,
      }));
      return new Response(JSON.stringify({ data: { items }, meta: {} }), { status: 200 });
    }
    if (url.pathname === '/api/v1/collections' && method === 'POST') {
      const name = (body as { name: string }).name;
      const existing = server.collections.get(name);
      if (existing !== undefined) {
        return errorResponse(409, 'COLLECTION_NAME_CONFLICT');
      }
      server.sequence += 1;
      const id = `00000000-0000-0000-0000-${String(server.sequence).padStart(12, '0')}`;
      server.collections.set(name, { id, itemCount: 0 });
      server.items.set(id, new Set());
      return new Response(
        JSON.stringify({ data: { id, name, createdAt: '2026-09-07T00:00:00.000Z', itemCount: 0 } }),
        { status: 201 },
      );
    }
    const itemsMatch = /^\/api\/v1\/collections\/([^/]+)\/items$/.exec(url.pathname);
    if (itemsMatch !== null && method === 'POST') {
      const collectionId = itemsMatch[1]!;
      const entry = [...server.collections.entries()].find(([, c]) => c.id === collectionId);
      if (entry === undefined) {
        return errorResponse(404, 'NOT_FOUND');
      }
      const itemKey = (body as { itemKey: string }).itemKey;
      if (server.failItemKeys.has(itemKey)) {
        return errorResponse(404, 'NOT_FOUND');
      }
      const set = server.items.get(collectionId)!;
      if (!set.has(itemKey)) {
        set.add(itemKey);
        entry[1].itemCount += 1;
      }
      // W03 semantics: an idempotent replay returns the identical shape.
      return new Response(
        JSON.stringify({
          data: {
            collectionId,
            itemType: 'template',
            itemKey,
            addedAt: '2026-09-07T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    }
    return errorResponse(404, 'NOT_FOUND');
  }) as typeof fetch;
}

function sampleRecord(): LocalRecord {
  return {
    schemaVersion: 1,
    favorites: ['case-1', 'case-2'],
    recent: [{ id: 'case-1', viewedAt: '2026-09-06T00:00:00.000Z' }],
    collections: [{ id: 'local-1', name: '海报灵感', templateIds: ['case-2', 'case-3'] }],
  };
}

describe('importRecordToServer (W04)', () => {
  it('imports favorites and collections; a repeated import adds 0 new and reports everything skipped', async () => {
    const server = startFakeServer();
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl: fakeFetch(server) });

    const first = await importRecordToServer(client, sampleRecord());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.report.collectionsNew).toBe(2);
    expect(first.report.collectionsExisting).toBe(0);
    // case-1, case-2 (favorites) + case-2, case-3 (collection) = 4 adds.
    expect(first.report.itemsNew).toBe(4);
    expect(first.report.itemsSkipped).toBe(0);
    expect(first.report.failures).toEqual([]);

    const callsBefore = server.calls.length;
    const second = await importRecordToServer(client, sampleRecord());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.report.collectionsNew).toBe(0);
    expect(second.report.collectionsExisting).toBe(2);
    expect(second.report.itemsNew).toBe(0);
    expect(second.report.itemsSkipped).toBe(4);
    expect(second.report.failures).toEqual([]);
    expect(server.calls.length).toBeGreaterThan(callsBefore);

    // The fake server still holds exactly the deduplicated rows.
    const favoritesCollection = server.collections.get(IMPORTED_FAVORITES_COLLECTION)!;
    expect(server.items.get(favoritesCollection.id)!.size).toBe(2);
  });

  it('rejects a corrupted record with invalid-record and sends zero requests', async () => {
    const server = startFakeServer();
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl: fakeFetch(server) });

    const result = await importRecordToServer(client, {
      schemaVersion: 99,
      favorites: 'not-an-array',
    });
    expect(result).toEqual({ ok: false, error: 'invalid-record' });
    expect(server.calls).toHaveLength(0);
  });

  it('continues past a partial item failure and reports it with its stable code', async () => {
    const server = startFakeServer({ failItemKeys: ['case-3'] });
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl: fakeFetch(server) });

    const result = await importRecordToServer(client, sampleRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.itemsNew).toBe(3);
    expect(result.report.itemsFailed).toBe(1);
    expect(result.report.failures).toEqual([{ label: '海报灵感/case-3', reason: 'NOT_FOUND' }]);
    // The good items still landed.
    const collection = server.collections.get('海报灵感')!;
    expect([...server.items.get(collection.id)!]).toEqual(['case-2']);
  });

  it('sends only whitelisted bodies — never BYOK keys, settings, or recent views', async () => {
    const server = startFakeServer();
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl: fakeFetch(server) });

    const poisoned = {
      ...sampleRecord(),
      byokKey: 'sk-must-not-leak',
      byokEndpoint: 'https://evil.example',
      settings: { model: 'x' },
    };
    const result = await importRecordToServer(client, poisoned);
    expect(result.ok).toBe(true);

    for (const call of server.calls) {
      expect(call.url).not.toContain('sk-must-not-leak');
      if (call.body === undefined) {
        continue;
      }
      const keys = Object.keys(call.body as Record<string, unknown>).sort();
      const allowed = [['name'], ['itemKey', 'itemType']];
      expect(allowed).toContainEqual(keys);
      expect(JSON.stringify(call.body)).not.toContain('sk-must-not-leak');
      expect(JSON.stringify(call.body)).not.toContain('evil.example');
    }
    // Recent views are never part of the import plan.
    expect(JSON.stringify(server.calls)).not.toContain('viewedAt');
  });

  it('returns unauthenticated on 401 without partial writes continuing', async () => {
    const server = startFakeServer();
    const client = createOnePicClient({
      baseUrl: 'http://api.test',
      fetchImpl: (async () => errorResponse(401, 'UNAUTHENTICATED')) as typeof fetch,
    });

    const result = await importRecordToServer(client, sampleRecord());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('unauthenticated');
    expect(server.collections.size).toBe(0);
  });

  it('empty local record is a successful no-op import', async () => {
    const server = startFakeServer();
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl: fakeFetch(server) });

    const result = await importRecordToServer(client, {
      schemaVersion: 1,
      favorites: [],
      recent: [],
      collections: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({
      collectionsNew: 0,
      collectionsExisting: 0,
      itemsNew: 0,
      itemsSkipped: 0,
      itemsFailed: 0,
    });
  });
});

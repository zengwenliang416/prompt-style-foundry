import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { buildApp } from '../../api/src/bootstrap/app.js';
import type { ApiConfig } from '../../api/src/config/env.js';
import { runMigrations } from '../../api/src/db/migrate.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../../api/src/modules/catalog/import.js';
import { PgSessionRepository } from '../../api/src/modules/identity/pg-session-repository.js';

/**
 * W03 acceptance over real HTTP + real PG + real storage:
 * cross-user isolation (IDOR → 403/404), stable cursor pagination (no dup /
 * no miss, concurrent insert does not reshuffle, equal timestamps tiebreak
 * by id), idempotent favoriting (PK), collection deletion never touching
 * generations/media, and cursor tamper / unknown-field / limit-cap 400s.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SIGNING_KEY = ['w03', 'test', 'signing', 'key', 'at-least-32-characters'].join('-');
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';

const PROMPT_BODY =
  '[System / Prompt]\nw03 unique prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
const PROMPT_SHA = sha256Hex(stablePromptBody(PROMPT_BODY));
const INPUT_SHA = createHash('sha256').update(PNG_1X1).digest('hex');

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let app: ReturnType<typeof buildApp>;
let storageRoot = '';
let sessionA = '';
let sessionB = '';
let subjectA = '';
let counter = 0;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('workbench_w03');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'w03-storage-'));

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'w03-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: 'managed-primary',
  };
  app = buildApp(config);

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w03-a' });
  const b = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w03-b' });
  subjectA = a.id;
  sessionA = (await sessions.create({ subjectId: a.id, ttlSeconds: 3600 })).token;
  sessionB = (await sessions.create({ subjectId: b.id, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'w03-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'W03 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-101.txt',
        promptSha256: PROMPT_SHA,
        source: null,
      },
    ],
  };
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, 'data/library/templates.json'),
    JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }),
  );
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-101.txt'), PROMPT_BODY);
  await importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await app?.close();
  await client?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

function mutateHeaders(session: string): Record<string, string> {
  return {
    origin: ALLOWED_ORIGIN,
    'x-onepic-requested-with': 'onepic-fetch',
    cookie: `onepic_session=${session}`,
  };
}

function readHeaders(session: string): Record<string, string> {
  return { cookie: `onepic_session=${session}` };
}

/** Full HTTP path up to a submitted (queued) generation owned by session. */
async function submitQueued(session: string): Promise<string> {
  counter += 1;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: mutateHeaders(session),
    payload: { declaredBytes: PNG_1X1.length, declaredMime: 'image/png' },
  });
  const uploadId = created.json().data.uploadId as string;
  await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/bytes`,
    headers: { ...mutateHeaders(session), 'content-type': 'application/octet-stream' },
    payload: PNG_1X1,
  });
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/confirm`,
    headers: mutateHeaders(session),
    payload: { sha256: INPUT_SHA },
  });
  const mediaObjectId = confirmed.json().data.mediaObjectId as string;
  const precheck = await app.inject({
    method: 'POST',
    url: '/api/v1/prechecks',
    headers: mutateHeaders(session),
    payload: {
      templateId: 'case-101',
      templateVersion: 1,
      sourceObjectId: mediaObjectId,
      settings: { model: 'gpt-image-2', quality: 'high' },
    },
  });
  const submitted = await app.inject({
    method: 'POST',
    url: '/api/v1/generations',
    headers: { ...mutateHeaders(session), 'idempotency-key': `w03-${counter}-key` },
    payload: {
      templateId: 'case-101',
      templateVersion: 1,
      promptSha256: PROMPT_SHA,
      sourceObjectId: mediaObjectId,
      precheckId: precheck.json().data.precheckId,
      settings: { model: 'gpt-image-2', quality: 'high' },
    },
  });
  expect(submitted.statusCode).toBe(202);
  return submitted.json().data.id as string;
}

async function createCollection(session: string, name: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/collections',
    headers: mutateHeaders(session),
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  return created.json().data.id as string;
}

async function addItem(session: string, collectionId: string, itemType: string, itemKey: string) {
  return await app.inject({
    method: 'POST',
    url: `/api/v1/collections/${collectionId}/items`,
    headers: mutateHeaders(session),
    payload: { itemType, itemKey },
  });
}

async function listHistory(session: string, query = '') {
  return await app.inject({
    method: 'GET',
    url: `/api/v1/generations${query}`,
    headers: readHeaders(session),
  });
}

describe('workspace isolation and authorization (W03)', () => {
  it('keeps histories and collections private per subject; IDOR → 403/404; anonymous → 401', async () => {
    const generationId = await submitQueued(sessionA);
    const collectionId = await createCollection(sessionA, 'w03 isolation A');

    // B's own views are empty and never contain A's rows.
    const bHistory = await listHistory(sessionB);
    expect(bHistory.statusCode).toBe(200);
    expect(bHistory.json().data.items).toHaveLength(0);
    const bCollections = await app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: readHeaders(sessionB),
    });
    expect(bCollections.json().data.items).toHaveLength(0);

    // A sees exactly its own rows.
    const aHistory = await listHistory(sessionA);
    expect(aHistory.json().data.items.map((i: { id: string }) => i.id)).toContain(generationId);

    // IDOR attempts from B.
    const bDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collectionId}`,
      headers: mutateHeaders(sessionB),
    });
    expect(bDelete.statusCode).toBe(403);
    expect(bDelete.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const bAdd = await addItem(sessionB, collectionId, 'template', 'case-101');
    expect(bAdd.statusCode).toBe(403);

    const bRemove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collectionId}/items/template/case-101`,
      headers: mutateHeaders(sessionB),
    });
    expect(bRemove.statusCode).toBe(403);

    const bGeneration = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: readHeaders(sessionB),
    });
    expect(bGeneration.statusCode).toBe(403);

    // Missing collection → 404 for the real owner as well.
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/v1/collections/00000000-0000-0000-0000-0000000000ff',
      headers: mutateHeaders(sessionA),
    });
    expect(missing.statusCode).toBe(404);

    // Anonymous → 401 (history is a GET, so no CSRF headers involved).
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/generations' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('history cursor pagination (W03)', () => {
  it('pages through >2 pages without dup or miss; a concurrent insert never reshuffles later pages', async () => {
    // Other tests in this file also submit generations for sessionA; the walk
    // must cover exactly the rows present when pagination starts.
    const base = Number(
      (
        await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM generation WHERE owner_id = $1',
          [subjectA],
        )
      ).rows[0]!.n,
    );
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await submitQueued(sessionA));
    }
    // Force two rows onto the exact same created_at to exercise the id tiebreaker.
    await client.query('UPDATE generation SET created_at = $1 WHERE id = ANY($2::uuid[])', [
      new Date('2026-09-07T01:00:00Z'),
      [ids[1], ids[2]],
    ]);

    const page1 = await listHistory(sessionA, '?limit=2');
    expect(page1.statusCode).toBe(200);
    expect(page1.json().data.items).toHaveLength(2);
    const cursor1 = page1.json().meta.nextCursor as string;
    expect(typeof cursor1).toBe('string');

    // Concurrent insert after page 1 was issued: it sorts ahead of the first
    // page and must not appear in, or shift, the remaining pages.
    const lateId = await submitQueued(sessionA);

    const page2 = await listHistory(sessionA, `?limit=2&cursor=${encodeURIComponent(cursor1)}`);
    expect(page2.statusCode).toBe(200);
    expect(page2.json().data.items).toHaveLength(2);
    const cursor2 = page2.json().meta.nextCursor as string;

    const page3 = await listHistory(sessionA, `?limit=2&cursor=${encodeURIComponent(cursor2)}`);
    expect(page3.statusCode).toBe(200);

    const walked = [
      ...page1.json().data.items,
      ...page2.json().data.items,
      ...page3.json().data.items,
    ].map((i: { id: string }) => i.id);
    expect(new Set(walked).size).toBe(walked.length);
    for (const id of ids) {
      expect(walked).toContain(id);
    }
    expect(walked).not.toContain(lateId);
    // The walk terminates exactly after the rows that existed at page 1.
    expect(walked).toHaveLength(base + 5);
    expect(page3.json().meta.nextCursor ?? null).toBeNull();

    // Fresh first page sees the late insert first (created_at DESC).
    const fresh = await listHistory(sessionA, '?limit=1');
    expect(fresh.json().data.items[0].id).toBe(lateId);

    // Optional state filter.
    const queuedOnly = await listHistory(sessionA, '?state=queued&limit=50');
    expect(queuedOnly.statusCode).toBe(200);
    for (const item of queuedOnly.json().data.items) {
      expect(item.state).toBe('queued');
    }
    const noneSucceeded = await listHistory(sessionA, '?state=succeeded');
    expect(noneSucceeded.json().data.items).toHaveLength(0);

    // List items carry the generation-status shape (no result object queued).
    const item = page1.json().data.items[0];
    expect(item).toMatchObject({ templateId: 'case-101', templateVersion: 1, state: 'queued' });
    expect(typeof item.createdAt).toBe('string');
  });

  it('rejects tampered, malformed, and cross-endpoint cursors with 400; caps limit and rejects unknown query fields', async () => {
    const garbage = await listHistory(sessionA, '?cursor=not-a-cursor');
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    // A structurally valid but re-signed-elsewhere / bit-flipped token fails.
    const page1 = await listHistory(sessionA, '?limit=1');
    const valid = page1.json().meta.nextCursor as string;
    const flipped = `${valid.slice(0, -2)}${valid.endsWith('a') ? 'bb' : 'aa'}`;
    const tampered = await listHistory(sessionA, `?cursor=${encodeURIComponent(flipped)}`);
    expect(tampered.statusCode).toBe(400);

    // Unsigned hand-crafted payload (correct shape, no valid HMAC).
    const forgedPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        c: '2026-09-07T00:00:00.000Z',
        id: '00000000-0000-0000-0000-000000000001',
      }),
    ).toString('base64url');
    const forged = await listHistory(sessionA, `?cursor=${forgedPayload}.${'A'.repeat(43)}`);
    expect(forged.statusCode).toBe(400);

    // Out-of-range payload signed with the WRONG key is still rejected…
    const { encodeCursor } = await import('../../api/src/modules/workspace/cursor.js');
    const foreignSigned = encodeCursor(
      { createdAt: '2026-09-07T00:00:00.000Z', id: '00000000-0000-0000-0000-000000000001' },
      'some-other-key',
    );
    const wrongKey = await listHistory(sessionA, `?cursor=${encodeURIComponent(foreignSigned)}`);
    expect(wrongKey.statusCode).toBe(400);

    // …and an out-of-range date signed with the RIGHT key is refused too.
    const outOfRange = encodeCursor(
      { createdAt: '1990-01-01T00:00:00.000Z', id: '00000000-0000-0000-0000-000000000001' },
      SIGNING_KEY,
    );
    const ranged = await listHistory(sessionA, `?cursor=${encodeURIComponent(outOfRange)}`);
    expect(ranged.statusCode).toBe(400);

    // Unknown query fields fail loudly.
    const unknownField = await listHistory(sessionA, '?limit=2&surprise=1');
    expect(unknownField.statusCode).toBe(400);

    // Limit cap.
    const tooBig = await listHistory(sessionA, '?limit=51');
    expect(tooBig.statusCode).toBe(400);
  });
});

describe('collections and favorites (W03)', () => {
  it('creates collections, rejects duplicate names with 409, and lists with item counts', async () => {
    const first = await createCollection(sessionA, 'w03 dup check');
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionA),
      payload: { name: 'w03 dup check' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: { code: 'COLLECTION_NAME_CONFLICT' } });

    // The same name is free for another owner (uniqueness is per-owner).
    const forB = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionB),
      payload: { name: 'w03 dup check' },
    });
    expect(forB.statusCode).toBe(201);

    // Blank names are rejected.
    const blank = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionA),
      payload: { name: '   ' },
    });
    expect(blank.statusCode).toBe(400);

    // Unknown body fields fail loudly.
    const extra = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionA),
      payload: { name: 'w03 extra field', bogus: true },
    });
    expect(extra.statusCode).toBe(400);

    const added = await addItem(sessionA, first, 'template', 'case-101');
    expect(added.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: readHeaders(sessionA),
    });
    expect(list.statusCode).toBe(200);
    const mine = (
      list.json().data.items as Array<{ id: string; name: string; itemCount: number }>
    ).find((c) => c.id === first);
    expect(mine).toMatchObject({ name: 'w03 dup check', itemCount: 1 });
  });

  it('repeated favoriting is idempotent: same response, original addedAt, exactly one DB row', async () => {
    const collectionId = await createCollection(sessionA, 'w03 idempotent fav');

    const first = await addItem(sessionA, collectionId, 'template', 'case-101');
    expect(first.statusCode).toBe(200);
    const second = await addItem(sessionA, collectionId, 'template', 'case-101');
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toEqual(first.json().data);

    const rows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM collection_item
       WHERE collection_id = $1 AND item_type = 'template' AND item_key = 'case-101'`,
      [collectionId],
    );
    expect(rows.rows[0]!.n).toBe('1');

    // Item removal is idempotent too.
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collectionId}/items/template/case-101`,
      headers: mutateHeaders(sessionA),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toMatchObject({ removed: true });
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collectionId}/items/template/case-101`,
      headers: mutateHeaders(sessionA),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ removed: false });
  });

  it('validates favorites: foreign generation 403, missing generation 404, unknown template 404, malformed keys 400', async () => {
    const generationId = await submitQueued(sessionA);
    const collectionA = await createCollection(sessionA, 'w03 fav validation A');
    const collectionB = await createCollection(sessionB, 'w03 fav validation B');

    // B cannot favorite A's generation (into B's own collection).
    const foreign = await addItem(sessionB, collectionB, 'generation', generationId);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    // The owner can.
    const own = await addItem(sessionA, collectionA, 'generation', generationId);
    expect(own.statusCode).toBe(200);
    expect(own.json().data).toMatchObject({ itemType: 'generation', itemKey: generationId });

    const missing = await addItem(
      sessionA,
      collectionA,
      'generation',
      '00000000-0000-0000-0000-0000000000ee',
    );
    expect(missing.statusCode).toBe(404);

    const unknownTemplate = await addItem(sessionA, collectionA, 'template', 'case-999999');
    expect(unknownTemplate.statusCode).toBe(404);

    const badTemplateKey = await addItem(sessionA, collectionA, 'template', 'not-a-template-key');
    expect(badTemplateKey.statusCode).toBe(400);

    const badGenerationKey = await addItem(sessionA, collectionA, 'generation', 'not-a-uuid');
    expect(badGenerationKey.statusCode).toBe(400);
  });

  it('deleting a collection removes only the collection and its links — generations and media survive', async () => {
    const generationId = await submitQueued(sessionA);
    const collectionId = await createCollection(sessionA, 'w03 delete safety');
    await addItem(sessionA, collectionId, 'generation', generationId);
    await addItem(sessionA, collectionId, 'template', 'case-101');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collectionId}`,
      headers: mutateHeaders(sessionA),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toEqual({ id: collectionId, deleted: true });

    // Collection + member links are gone…
    const collectionRows = await client.query('SELECT 1 FROM collection WHERE id = $1', [
      collectionId,
    ]);
    expect(collectionRows.rows).toHaveLength(0);
    const itemRows = await client.query('SELECT 1 FROM collection_item WHERE collection_id = $1', [
      collectionId,
    ]);
    expect(itemRows.rows).toHaveLength(0);

    // …but the generation, its input media, and the job row are untouched.
    const generationRows = await client.query('SELECT state FROM generation WHERE id = $1', [
      generationId,
    ]);
    expect(generationRows.rows).toHaveLength(1);
    const mediaRows = await client.query(
      `SELECT 1 FROM media_object m JOIN generation g ON g.input_object_id = m.id WHERE g.id = $1`,
      [generationId],
    );
    expect(mediaRows.rows).toHaveLength(1);

    // The task remains fully readable through the workbench API.
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: readHeaders(sessionA),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.state).toBe('queued');

    // And it still appears in history.
    const history = await listHistory(sessionA, '?limit=50');
    expect(history.json().data.items.map((i: { id: string }) => i.id)).toContain(generationId);

    // Deleting twice is a plain 404.
    const twice = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collectionId}`,
      headers: mutateHeaders(sessionA),
    });
    expect(twice.statusCode).toBe(404);

    // Favorite rows referencing the deleted collection cannot be re-added.
    const readd = await addItem(sessionA, collectionId, 'template', 'case-101');
    expect(readd.statusCode).toBe(404);

    void subjectA;
  });
});

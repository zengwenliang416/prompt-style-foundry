import path from 'node:path';
import { Writable } from 'node:stream';
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
 * O03 security negative matrix — the cases NOT already covered elsewhere
 * (see docs/design/security-negative-matrix.md for the full mapping):
 * SQL injection through cursor/collection-name/itemKey, XSS-shaped metadata
 * stored verbatim with a JSON content type, upload-bypass attempts (tampered
 * confirm hash, disguised bytes content-type), quota exhaustion and
 * release-then-reacquire over HTTP, CSRF guard on a mutating route, and a
 * log-leak sentinel embedded in collection metadata.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const INPUT_SHA = createHash('sha256').update(PNG_1X1).digest('hex');
const SIGNING_KEY = ['o03', 'test', 'signing', 'key', 'at-least-32-characters'].join('-');
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';
const LOG_SENTINEL = 'o03-sentinel-collection-zqxw';

const PROMPT_BODY =
  '[System / Prompt]\no03 prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
const PROMPT_SHA = sha256Hex(stablePromptBody(PROMPT_BODY));

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let app: ReturnType<typeof buildApp>;
let storageRoot = '';
let sessionA = '';
let counter = 0;
const logLines: string[] = [];

class CaptureStream extends Writable {
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    logLines.push(String(chunk));
    callback();
  }
}

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('security_negative_o03');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'o03-storage-'));

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'o03-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: 'managed-primary',
    // Quota of exactly 1 so exhaustion is reachable over real HTTP.
    generationQuotaLimit: 1,
  };
  app = buildApp(config, { logStream: new CaptureStream() });

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'o03-a' });
  sessionA = (await sessions.create({ subjectId: a.id, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'o03-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'O03 模板',
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

/** Drives upload → precheck so a generation can be submitted. */
async function prepareGenerationInputs(): Promise<{
  mediaObjectId: string;
  precheckId: string;
}> {
  counter += 1;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: mutateHeaders(sessionA),
    payload: { declaredBytes: PNG_1X1.length, declaredMime: 'image/png' },
  });
  const uploadId = created.json().data.uploadId as string;
  await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/bytes`,
    headers: { ...mutateHeaders(sessionA), 'content-type': 'application/octet-stream' },
    payload: PNG_1X1,
  });
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/confirm`,
    headers: mutateHeaders(sessionA),
    payload: { sha256: INPUT_SHA },
  });
  expect(confirmed.statusCode).toBe(200);
  const mediaObjectId = confirmed.json().data.mediaObjectId as string;
  const precheck = await app.inject({
    method: 'POST',
    url: '/api/v1/prechecks',
    headers: mutateHeaders(sessionA),
    payload: {
      templateId: 'case-101',
      templateVersion: 1,
      sourceObjectId: mediaObjectId,
      settings: { model: 'gpt-image-2', quality: 'high' },
    },
  });
  expect(precheck.statusCode).toBe(201);
  return { mediaObjectId, precheckId: precheck.json().data.precheckId as string };
}

async function submit(mediaObjectId: string, precheckId: string) {
  counter += 1;
  return await app.inject({
    method: 'POST',
    url: '/api/v1/generations',
    headers: { ...mutateHeaders(sessionA), 'idempotency-key': `o03-${counter}-key` },
    payload: {
      templateId: 'case-101',
      templateVersion: 1,
      promptSha256: PROMPT_SHA,
      sourceObjectId: mediaObjectId,
      precheckId,
      settings: { model: 'gpt-image-2', quality: 'high' },
    },
  });
}

describe('SQL injection negatives (O03)', () => {
  it('treats injection strings as data: cursor → 400, names/itemKeys stored verbatim, DB intact', async () => {
    // Signed cursor: a forged/injected cursor fails HMAC verification → 400.
    const cursorAttack = await app.inject({
      method: 'GET',
      url: `/api/v1/generations?cursor=${encodeURIComponent("' OR 1=1;--")}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(cursorAttack.statusCode).toBe(400);

    // Collection name with an injection payload is stored verbatim (no error,
    // no interpretation) — parameterized queries make it inert text.
    const name = "x' OR '1'='1'; DROP TABLE generation;--";
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionA),
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    const collectionId = created.json().data.id as string;
    expect(created.json().data.name).toBe(name);

    // itemKey injection is rejected by format validation (template keys must
    // match case-N/framework-NNN) — a clean 400, never a SQL error or 500.
    const itemKey = "case-101' UNION SELECT session_token FROM session;--";
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collectionId}/items`,
      headers: mutateHeaders(sessionA),
      payload: { itemType: 'template', itemKey },
    });
    expect(added.statusCode).toBe(400);
    const itemCount = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection_item WHERE collection_id = $1',
      [collectionId],
    );
    expect(itemCount.rows[0]!.n).toBe('0');

    // The database is structurally intact and the list endpoints still work.
    const tables = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM generation`);
    expect(Number(tables.rows[0]!.n)).toBeGreaterThanOrEqual(0);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items.map((i: { name: string }) => i.name)).toContain(name);
    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/generations',
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(history.statusCode).toBe(200);
  });
});

describe('XSS-shaped metadata (O03)', () => {
  it('stores and returns markup-carrying names verbatim as application/json (never executed)', async () => {
    const name = `<script>alert('o03')</script><img src=x onerror=alert(1)>`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionA),
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['content-type']).toContain('application/json');
    expect(created.json().data.name).toBe(name);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(list.headers['content-type']).toContain('application/json');
    const names = list.json().data.items.map((i: { name: string }) => i.name) as string[];
    expect(names).toContain(name);
  });
});

describe('upload bypass negatives (O03)', () => {
  it('rejects a tampered confirm hash (400 HASH_MISMATCH) and accepts the correct retry', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: mutateHeaders(sessionA),
      payload: { declaredBytes: PNG_1X1.length, declaredMime: 'image/png' },
    });
    const uploadId = created.json().data.uploadId as string;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/bytes`,
      headers: { ...mutateHeaders(sessionA), 'content-type': 'application/octet-stream' },
      payload: PNG_1X1,
    });

    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/confirm`,
      headers: mutateHeaders(sessionA),
      payload: { sha256: 'f'.repeat(64) },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: { code: 'HASH_MISMATCH' } });
    // The forged hash was NOT recorded.
    const media = await client.query<{ sha256: string }>(
      'SELECT m.sha256 FROM upload u JOIN media_object m ON m.id = u.media_object_id WHERE u.id = $1',
      [uploadId],
    );
    expect(media.rows[0]!.sha256).toBe('pending');

    // The session survives the failed attempt; the correct hash confirms.
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/confirm`,
      headers: mutateHeaders(sessionA),
      payload: { sha256: INPUT_SHA },
    });
    expect(confirmed.statusCode).toBe(200);
  });

  it('rejects bytes sent with a disguised content type', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: mutateHeaders(sessionA),
      payload: { declaredBytes: PNG_1X1.length, declaredMime: 'image/png' },
    });
    const uploadId = created.json().data.uploadId as string;
    const disguised = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/bytes`,
      headers: { ...mutateHeaders(sessionA), 'content-type': 'text/html' },
      payload: PNG_1X1,
    });
    expect(disguised.statusCode).toBe(415);
    expect(disguised.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    // Nothing was stored: confirm now fails as incomplete.
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/confirm`,
      headers: mutateHeaders(sessionA),
      payload: { sha256: INPUT_SHA },
    });
    expect(confirmed.statusCode).toBe(400);
    expect(confirmed.json()).toMatchObject({ error: { code: 'INCOMPLETE_UPLOAD' } });
  });
});

describe('quota competition over HTTP (O03)', () => {
  it('exhausts the quota (429 QUOTA_EXCEEDED) and re-acquires after a cancel release', async () => {
    const first = await prepareGenerationInputs();
    const created = await submit(first.mediaObjectId, first.precheckId);
    expect(created.statusCode).toBe(202);
    const generationId = created.json().data.id as string;

    const second = await prepareGenerationInputs();
    const exhausted = await submit(second.mediaObjectId, second.precheckId);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });

    // Cancelling the queued task releases the reservation exactly once…
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/generations/${generationId}/cancel`,
      headers: mutateHeaders(sessionA),
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);

    // …and the freed slot can be re-acquired (still capped at one).
    const third = await prepareGenerationInputs();
    const reacquired = await submit(third.mediaObjectId, third.precheckId);
    expect(reacquired.statusCode).toBe(202);
  });
});

describe('CSRF guard on mutating routes (O03)', () => {
  it('rejects a headerless cross-site POST even with a valid session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: { cookie: `onepic_session=${sessionA}` },
      payload: { name: 'csrf-attempt' },
    });
    expect(response.statusCode).toBe(403);
    // The collection was never created.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(list.json().data.items.map((i: { name: string }) => i.name)).not.toContain(
      'csrf-attempt',
    );
  });
});

describe('log leakage via metadata (O03)', () => {
  it('never logs a sentinel embedded in a collection name (request bodies are not logged)', async () => {
    const baseline = logLines.length;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutateHeaders(sessionA),
      payload: { name: LOG_SENTINEL },
    });
    expect(created.statusCode).toBe(201);
    const newLines = logLines.slice(baseline);
    expect(newLines.length).toBeGreaterThan(0);
    for (const line of newLines) {
      expect(line).not.toContain(LOG_SENTINEL);
    }
  });
});

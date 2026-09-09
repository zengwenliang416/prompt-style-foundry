import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createRequire } from 'node:module';
import type { ErrorObject } from 'ajv';

// ajv ships CJS typings; under NodeNext (no esModuleInterop) the class is
// reached through createRequire instead of ESM default-import interop.
const require = createRequire(import.meta.url);
const { default: Ajv2020 } = require('ajv/dist/2020.js') as {
  default: new (opts?: { allErrors?: boolean }) => {
    validate(schema: unknown, data: unknown): boolean;
    errors: ErrorObject[] | null | undefined;
  };
};
const addFormats = (require('ajv-formats') as { default: (ajv: unknown) => unknown }).default;

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
 * W04 export acceptance over real HTTP + real PG: the workspace export
 * contains ONLY the requesting subject's records (cross-user isolation),
 * validates against docs/design/backend-schemas/workspace-export.schema.json,
 * walks the full history across cursor pages (>1 page), and its serialized
 * bytes contain no secrets (keys/sessions/signing material).
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SIGNING_KEY = ['w04', 'test', 'signing', 'key', 'at-least-32-characters'].join('-');
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';
// 52 rows force the export's internal keyset walk across two 50-row pages.
const HISTORY_ROWS = 52;

const PROMPT_BODY =
  '[System / Prompt]\nw04 unique prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
const PROMPT_SHA = sha256Hex(stablePromptBody(PROMPT_BODY));
const INPUT_SHA = createHash('sha256').update(PNG_1X1).digest('hex');

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let app: ReturnType<typeof buildApp>;
let storageRoot = '';
let sessionA = '';
let sessionB = '';
let sessionC = '';
let counter = 0;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('workbench_w04');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'w04-storage-'));

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'w04-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: 'managed-primary',
    generationQuotaLimit: 100,
  };
  app = buildApp(config);

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w04-a' });
  const b = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w04-b' });
  const c = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w04-c' });
  sessionA = (await sessions.create({ subjectId: a.id, ttlSeconds: 3600 })).token;
  sessionB = (await sessions.create({ subjectId: b.id, ttlSeconds: 3600 })).token;
  sessionC = (await sessions.create({ subjectId: c.id, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'w04-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'W04 模板',
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
    headers: { ...mutateHeaders(session), 'idempotency-key': `w04-${counter}-key` },
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
  const added = await app.inject({
    method: 'POST',
    url: `/api/v1/collections/${collectionId}/items`,
    headers: mutateHeaders(session),
    payload: { itemType, itemKey },
  });
  expect(added.statusCode).toBe(200);
}

async function exportWorkspace(session: string) {
  return await app.inject({
    method: 'GET',
    url: '/api/v1/exports/workspace',
    headers: { cookie: `onepic_session=${session}` },
  });
}

describe('workspace export (W04)', () => {
  it("exports only the owner's records, validates against the published schema, and walks every history page", async () => {
    // A: multi-page history + collections with template and generation items.
    const generationIds: string[] = [];
    for (let i = 0; i < HISTORY_ROWS; i += 1) {
      generationIds.push(await submitQueued(sessionA));
    }
    const collectionA1 = await createCollection(sessionA, 'w04 A 集合一');
    const collectionA2 = await createCollection(sessionA, 'w04 A 集合二');
    await addItem(sessionA, collectionA1, 'template', 'case-101');
    await addItem(sessionA, collectionA1, 'generation', generationIds[0]!);
    await addItem(sessionA, collectionA2, 'template', 'case-101'); // same template in two collections → favorites dedupe

    // B: different records that must never leak into A's export.
    const generationB = await submitQueued(sessionB);
    const collectionB = await createCollection(sessionB, 'w04 B 私密集合');
    await addItem(sessionB, collectionB, 'generation', generationB);

    const response = await exportWorkspace(sessionA);
    expect(response.statusCode).toBe(200);
    const document = response.json().data;

    // Full schema validation against the published document schema.
    const schema = JSON.parse(
      await readFile(
        path.join(__dirname, '../../../docs/design/backend-schemas/workspace-export.schema.json'),
        'utf8',
      ),
    );
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const valid = ajv.validate(schema, document);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);

    // Complete multi-page history: all 52 of A's rows, nothing else.
    expect(document.history).toHaveLength(HISTORY_ROWS);
    const exportedIds = new Set(
      document.history.map((h: { generationId: string }) => h.generationId),
    );
    for (const id of generationIds) {
      expect(exportedIds.has(id)).toBe(true);
    }
    expect(exportedIds.has(generationB)).toBe(false);

    // Favorites dedupe across collections; B's collection never appears.
    expect(document.favorites).toEqual(['case-101']);
    const names = document.collections.map((c: { name: string }) => c.name);
    expect(names).toEqual(['w04 A 集合一', 'w04 A 集合二']);
    expect(names).not.toContain('w04 B 私密集合');
    const first = document.collections[0];
    expect(first.items).toContainEqual({ itemType: 'template', itemKey: 'case-101' });
    expect(first.items).toContainEqual({ itemType: 'generation', itemKey: generationIds[0] });

    // The serialized bytes carry no secrets of any kind.
    const serialized = response.body;
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain(SIGNING_KEY);
    expect(serialized).not.toContain(sessionA);
    expect(serialized).not.toContain(sessionB);
    expect(serialized).not.toContain('onepic_session');
    expect(serialized).not.toContain(PROMPT_BODY);
  });

  it('exports an empty-shaped document for a subject with no records and rejects anonymous callers', async () => {
    const empty = await exportWorkspace(sessionC);
    expect(empty.statusCode).toBe(200);
    const document = empty.json().data;
    expect(document.schemaVersion).toBe('1.0.0');
    expect(typeof document.exportedAt).toBe('string');
    expect(document.favorites).toEqual([]);
    expect(document.collections).toEqual([]);
    expect(document.history).toEqual([]);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/exports/workspace' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

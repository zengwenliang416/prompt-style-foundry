import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import sharp from 'sharp';

import {
  readMultipartTextField,
  startMockProvider,
  startPgTestCluster,
  type MockProviderHandle,
  type PgTestCluster,
} from '@onepic/test-support';

import { buildApp } from '../../api/src/bootstrap/app.js';
import type { ApiConfig } from '../../api/src/config/env.js';
import { runMigrations } from '../../api/src/db/migrate.js';
import { LocalDiskStorage } from '../../api/src/infra/storage/storage.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../../api/src/modules/catalog/import.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { verifySignedMedia } from '../../api/src/modules/media/signed-access.js';
import { PgSessionRepository } from '../../api/src/modules/identity/pg-session-repository.js';
import { claimJobs, completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';
import { validateImage } from '../../api/src/modules/media/validate-image.js';

/**
 * W01 acceptance: the workbench path upload → precheck → submit → poll →
 * download runs end-to-end over real HTTP (fastify inject), a real PG
 * cluster, the real local disk storage adapter, and the scripted mock
 * provider. Covers refresh-recovery semantics (in-flight task readable via
 * the same session), double-submit idempotency, and cross-user isolation.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SIGNING_KEY = ['w01', 'test', 'signing', 'key', 'at-least-32-characters'].join('-');
const PROVIDER_KEY = 'sk-w01-secret';
const PROVIDER_ID = 'managed-primary';
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';

const PROMPT_BODY =
  '[System / Prompt]\nw01 unique prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
const PROMPT_SHA = sha256Hex(stablePromptBody(PROMPT_BODY));
const INPUT_SHA = createHash('sha256').update(PNG_1X1).digest('hex');

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: Pool;
let provider: MockProviderHandle;
let app: ReturnType<typeof buildApp>;
let storageRoot = '';
let subjectA = '';
let subjectB = '';
let sessionA = '';
let sessionB = '';

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('workbench');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  provider = await startMockProvider();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'w01-storage-'));

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'w01-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: PROVIDER_ID,
  };
  app = buildApp(config);

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w01-a' });
  const b = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w01-b' });
  subjectA = a.id;
  subjectB = b.id;
  sessionA = (await sessions.create({ subjectId: subjectA, ttlSeconds: 3600 })).token;
  sessionB = (await sessions.create({ subjectId: subjectB, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'w01-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'W01 模板',
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
  await provider?.close();
  await client?.end();
  await pool?.end();
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

interface SubmitResult {
  generationId: string;
  uploadId: string;
  mediaObjectId: string;
  precheckId: string;
}

/** Drives upload → confirm → precheck over HTTP and returns the ids. */
async function uploadAndPrecheck(session: string): Promise<Omit<SubmitResult, 'generationId'>> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: mutateHeaders(session),
    payload: { declaredBytes: PNG_1X1.length, declaredMime: 'image/png' },
  });
  expect(created.statusCode).toBe(201);
  const uploadId = created.json().data.uploadId as string;

  const bytes = await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/bytes`,
    headers: { ...mutateHeaders(session), 'content-type': 'application/octet-stream' },
    payload: PNG_1X1,
  });
  expect(bytes.statusCode).toBe(200);
  expect(bytes.json().data.bytes).toBe(PNG_1X1.length);

  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/confirm`,
    headers: mutateHeaders(session),
    payload: { sha256: INPUT_SHA },
  });
  expect(confirmed.statusCode).toBe(200);
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
  expect(precheck.statusCode).toBe(201);
  return { uploadId, mediaObjectId, precheckId: precheck.json().data.precheckId as string };
}

async function submitGeneration(
  session: string,
  ids: Omit<SubmitResult, 'generationId'>,
  idempotencyKey: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/generations',
    headers: { ...mutateHeaders(session), 'idempotency-key': idempotencyKey },
    payload: {
      templateId: 'case-101',
      templateVersion: 1,
      promptSha256: PROMPT_SHA,
      sourceObjectId: ids.mediaObjectId,
      precheckId: ids.precheckId,
      settings: { model: 'gpt-image-2', quality: 'high' },
    },
  });
  expect(response.statusCode).toBe(202);
  return response.json().data.id as string;
}

async function getGeneration(session: string, generationId: string) {
  return await app.inject({
    method: 'GET',
    url: `/api/v1/generations/${generationId}`,
    headers: { cookie: `onepic_session=${session}` },
  });
}

/** Runs the worker loop once against the mock provider (3×2 PNG result). */
async function runWorkerOnce(generationId: string): Promise<Buffer> {
  const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#654321' } })
    .png()
    .toBuffer();
  provider.scriptResponses([
    { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
  ]);

  const deps: ExecutionDeps = {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: PROVIDER_ID,
        label: 'managed mock',
        baseUrl: provider.baseUrl,
        apiKey: PROVIDER_KEY,
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage: new LocalDiskStorage(storageRoot),
    validateImage,
    providerId: PROVIDER_ID,
  };
  // Earlier tests may leave their own pending jobs in the queue; claim in a
  // loop and work off whatever comes up until OUR generation is claimed.
  for (let guard = 0; guard < 8; guard += 1) {
    const [lease] = await claimJobs(client, { workerId: 'w01', kinds: ['generate'] });
    if (lease === undefined) {
      throw new Error(`no pending job for ${generationId}`);
    }
    const outcome = await executeClaimedJob(deps, {
      jobId: lease.jobId,
      workerId: 'w01',
      generationId: lease.generationId,
    });
    expect(outcome.ok).toBe(true);
    await completeJob(client, {
      jobId: lease.jobId,
      workerId: 'w01',
      generationId: lease.generationId,
      generationState: 'succeeded',
    });
    if (lease.generationId === generationId) {
      return image;
    }
  }
  throw new Error(`job for ${generationId} was not claimed`);
}

describe('workbench flow (W01)', () => {
  it('runs upload → precheck → submit → worker → poll → signed download end-to-end', async () => {
    const ids = await uploadAndPrecheck(sessionA);
    const generationId = await submitGeneration(sessionA, ids, 'w01-flow-1');

    const image = await runWorkerOnce(generationId);

    const status = await getGeneration(sessionA, generationId);
    expect(status.statusCode).toBe(200);
    const { data, meta } = status.json();
    expect(data).toMatchObject({
      id: generationId,
      state: 'succeeded',
      templateId: 'case-101',
      templateVersion: 1,
    });
    expect(data.result).toMatchObject({
      actualMime: 'image/png',
      actualWidth: 3,
      actualHeight: 2,
      actualBytes: image.length,
      sha256: createHash('sha256').update(image).digest('hex'),
    });
    expect(typeof data.result.objectId).toBe('string');
    expect(typeof meta.pollAfterMs).toBe('number');
    expect(typeof meta.downloadUrl).toBe('string');

    // The signed URL verifies against the signing key and the owner binding…
    const url = new URL(meta.downloadUrl, 'http://127.0.0.1');
    const parts = url.pathname.split('/');
    const verified = verifySignedMedia(
      {
        bucket: parts[4]!,
        key: parts.slice(5).join('/'),
        ownerId: url.searchParams.get('owner') ?? '',
        expires: url.searchParams.get('expires') ?? undefined,
        signature: url.searchParams.get('signature') ?? undefined,
        method: 'GET',
      },
      SIGNING_KEY,
    );
    expect(verified.ok).toBe(true);
    expect(url.searchParams.get('owner')).toBe(subjectA);

    // …and the media route actually serves the bytes to the owning session.
    const download = await app.inject({
      method: 'GET',
      url: meta.downloadUrl,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload?.equals(image)).toBe(true);
    expect(download.headers['cache-control']).toBe('private, no-store');

    const sidecarResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}/sidecar`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(sidecarResponse.statusCode).toBe(200);
    expect(sidecarResponse.json().data).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'onepic-generation-sidecar',
      generationId,
      state: 'succeeded',
      template: { key: 'case-101', version: 1 },
      prompt: { compiledSha256: PROMPT_SHA, effectiveSha256: PROMPT_SHA },
      input: { sha256: INPUT_SHA },
      result: {
        sha256: createHash('sha256').update(image).digest('hex'),
        mime: 'image/png',
        width: 3,
        height: 2,
      },
    });
    expect(JSON.stringify(sidecarResponse.json())).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(sidecarResponse.json())).not.toContain(PROMPT_BODY);
  });

  it('serves in-flight states to the same session (refresh recovery)', async () => {
    const ids = await uploadAndPrecheck(sessionA);
    const generationId = await submitGeneration(sessionA, ids, 'w01-flow-2');

    // Submitted but not yet claimed: the restored page polls `queued`.
    const queued = await getGeneration(sessionA, generationId);
    expect(queued.json().data.state).toBe('queued');

    // Claimed and executed but not completed: `running` — the mid-refresh
    // state a restored page must be able to resume polling from.
    const image = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    provider.scriptResponses([
      { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
    ]);
    const deps: ExecutionDeps = {
      db: client as unknown as Queryable,
      adapter: new ProviderAdapter(
        {
          providerId: PROVIDER_ID,
          label: 'managed mock',
          baseUrl: provider.baseUrl,
          apiKey: PROVIDER_KEY,
          models: [{ id: 'gpt-image-2', qualities: ['high'] }],
        },
        { fetchImpl: fetch },
      ),
      storage: new LocalDiskStorage(storageRoot),
      validateImage,
      providerId: PROVIDER_ID,
    };
    const [lease] = await claimJobs(client, { workerId: 'w01', kinds: ['generate'] });
    const outcome = await executeClaimedJob(deps, {
      jobId: lease!.jobId,
      workerId: 'w01',
      generationId,
    });
    expect(outcome.ok).toBe(true);

    const running = await getGeneration(sessionA, generationId);
    expect(running.json().data.state).toBe('running');

    await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'w01',
      generationId,
      generationState: 'succeeded',
    });
    const succeeded = await getGeneration(sessionA, generationId);
    expect(succeeded.json().data.state).toBe('succeeded');
    expect(typeof succeeded.json().meta.downloadUrl).toBe('string');
  });

  it('isolates objects per subject: cross-user reads/downloads forbidden, missing → 404, anonymous → 401', async () => {
    const ids = await uploadAndPrecheck(sessionA);
    const generationId = await submitGeneration(sessionA, ids, 'w01-flow-3');
    await runWorkerOnce(generationId);
    const downloadUrl = (await getGeneration(sessionA, generationId)).json().meta
      .downloadUrl as string;

    // B reads A's generation → FORBIDDEN.
    const asB = await getGeneration(sessionB, generationId);
    expect(asB.statusCode).toBe(403);
    expect(asB.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const sidecarAsB = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}/sidecar`,
      headers: { cookie: `onepic_session=${sessionB}` },
    });
    expect(sidecarAsB.statusCode).toBe(403);
    expect(sidecarAsB.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    // B presents A's signed download link → owner binding fails (404).
    const downloadAsB = await app.inject({
      method: 'GET',
      url: downloadUrl,
      headers: { cookie: `onepic_session=${sessionB}` },
    });
    expect(downloadAsB.statusCode).toBe(404);

    // Missing generation → NOT_FOUND.
    const missing = await getGeneration(sessionA, '00000000-0000-0000-0000-0000000000ff');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const missingSidecar = await app.inject({
      method: 'GET',
      url: '/api/v1/generations/00000000-0000-0000-0000-0000000000ff/sidecar',
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(missingSidecar.statusCode).toBe(404);
    expect(missingSidecar.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    // No session → UNAUTHENTICATED.
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const anonymousSidecar = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}/sidecar`,
    });
    expect(anonymousSidecar.statusCode).toBe(401);
    expect(anonymousSidecar.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    // B cannot confirm A's upload session either.
    const foreignConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${ids.uploadId}/confirm`,
      headers: mutateHeaders(sessionB),
      payload: { sha256: INPUT_SHA },
    });
    expect(foreignConfirm.statusCode).toBe(403);
  });

  it('replays the same idempotency key to the same task and conflicts on a different request', async () => {
    const ids = await uploadAndPrecheck(sessionA);
    const first = await submitGeneration(sessionA, ids, 'w01-idem-1');
    const second = await submitGeneration(sessionA, ids, 'w01-idem-1');
    expect(second).toBe(first);

    const rows = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM generation WHERE idempotency_key = 'w01-idem-1'",
    );
    expect(rows.rows[0]!.n).toBe('1');

    // Same key, different fingerprint (model differs) → 409.
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/generations',
      headers: { ...mutateHeaders(sessionA), 'idempotency-key': 'w01-idem-1' },
      payload: {
        templateId: 'case-101',
        templateVersion: 1,
        promptSha256: PROMPT_SHA,
        sourceObjectId: ids.mediaObjectId,
        precheckId: ids.precheckId,
        settings: { model: 'custom', quality: 'high' },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('rejects unknown request fields and prompt-hash substitution', async () => {
    const ids = await uploadAndPrecheck(sessionA);

    // Unknown field fails contract validation (removeAdditional: false).
    const extra = await app.inject({
      method: 'POST',
      url: '/api/v1/generations',
      headers: { ...mutateHeaders(sessionA), 'idempotency-key': 'w01-contract-1' },
      payload: {
        templateId: 'case-101',
        templateVersion: 1,
        promptSha256: PROMPT_SHA,
        sourceObjectId: ids.mediaObjectId,
        precheckId: ids.precheckId,
        settings: { model: 'gpt-image-2' },
        hackerField: true,
      },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    // A prompt hash that does not match the immutable version is refused.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/generations',
      headers: { ...mutateHeaders(sessionA), 'idempotency-key': 'w01-contract-2' },
      payload: {
        templateId: 'case-101',
        templateVersion: 1,
        promptSha256: 'f'.repeat(64),
        sourceObjectId: ids.mediaObjectId,
        precheckId: ids.precheckId,
        settings: { model: 'gpt-image-2' },
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: { code: 'PROMPT_REWRITE_BLOCKED' } });

    // The provider saw exactly the compiled prompt and nothing else (J05).
    const flowIds = await uploadAndPrecheck(sessionA);
    const generationId = await submitGeneration(sessionA, flowIds, 'w01-contract-3');
    await runWorkerOnce(generationId);
    const last = provider.requests[provider.requests.length - 1]!;
    const sentPrompt = readMultipartTextField(last, 'prompt');
    expect(createHash('sha256').update(sentPrompt!.replace(/\n+$/, '')).digest('hex')).toBe(
      PROMPT_SHA,
    );
    expect(last.headers['authorization']).toBe(`Bearer ${PROVIDER_KEY}`);
  });
});

import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import sharp from 'sharp';

import {
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
import { PgSessionRepository } from '../../api/src/modules/identity/pg-session-repository.js';
import { claimJobs, completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';
import { validateImage } from '../../api/src/modules/media/validate-image.js';

/**
 * W02 acceptance over real HTTP + real PG + real storage + mock provider:
 * cooperative cancel (queued / running / repeated / cross-user / terminal /
 * outcome_unknown refusal), and the expired-media path (history preserved,
 * download withdrawn, expired signature → 410).
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SIGNING_KEY = ['w02', 'test', 'signing', 'key', 'at-least-32-characters'].join('-');
const PROVIDER_ID = 'managed-primary';
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';

const PROMPT_BODY =
  '[System / Prompt]\nw02 unique prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
const PROMPT_SHA = sha256Hex(stablePromptBody(PROMPT_BODY));
const INPUT_SHA = createHash('sha256').update(PNG_1X1).digest('hex');

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: Pool;
let provider: MockProviderHandle;
let app: ReturnType<typeof buildApp>;
let storageRoot = '';
let sessionA = '';
let sessionB = '';
let counter = 0;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('workbench_w02');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  provider = await startMockProvider();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'w02-storage-'));

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'w02-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: PROVIDER_ID,
  };
  app = buildApp(config);

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w02-a' });
  const b = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'w02-b' });
  sessionA = (await sessions.create({ subjectId: a.id, ttlSeconds: 3600 })).token;
  sessionB = (await sessions.create({ subjectId: b.id, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'w02-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'W02 模板',
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

/** Full HTTP path up to a submitted (queued) generation. */
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
    headers: { ...mutateHeaders(session), 'idempotency-key': `w02-${counter}-key` },
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

function executionDeps(): ExecutionDeps {
  return {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: PROVIDER_ID,
        label: 'managed mock',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-w02-secret',
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage: new LocalDiskStorage(storageRoot),
    validateImage,
    providerId: PROVIDER_ID,
  };
}

async function resultImage(): Promise<Buffer> {
  return await sharp({ create: { width: 3, height: 2, channels: 3, background: '#654321' } })
    .png()
    .toBuffer();
}

async function cancelCall(session: string | null, generationId: string) {
  // Anonymous callers still carry the CSRF headers (the preHandler guard
  // rejects headerless cross-site posts with 403 before auth runs).
  const base = { origin: ALLOWED_ORIGIN, 'x-onepic-requested-with': 'onepic-fetch' };
  return await app.inject({
    method: 'POST',
    url: `/api/v1/generations/${generationId}/cancel`,
    headers: session === null ? base : { ...base, cookie: `onepic_session=${session}` },
    payload: {},
  });
}

describe('generation cancel over HTTP (W02)', () => {
  it('cancels a queued task: state cancelled, job removed, quota released once, provider never called', async () => {
    const generationId = await submitQueued(sessionA);
    const providerCallsBefore = provider.requests.length;

    const cancelled = await cancelCall(sessionA, generationId);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data).toMatchObject({
      id: generationId,
      state: 'cancelled',
      outcome: 'cancelled',
    });

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(status.json().data.state).toBe('cancelled');

    // The job is dead: no worker can ever claim it, nothing is sent upstream.
    const claimed = await claimJobs(client, { workerId: 'w02', kinds: ['generate'] });
    expect(claimed).toHaveLength(0);
    expect(provider.requests.length).toBe(providerCallsBefore);

    // Repeated cancel is idempotent: same state, and quota released exactly once.
    const again = await cancelCall(sessionA, generationId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ state: 'cancelled', outcome: 'already_terminal' });
    const ledger = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM quota_ledger WHERE generation_id = $1 AND reason = 'release'`,
      [generationId],
    );
    expect(ledger.rows[0]!.n).toBe('1');
  });

  it('records only a cancel request for a running task (CANCEL_NOT_GUARANTEED); an in-flight success still lands', async () => {
    const generationId = await submitQueued(sessionA);
    const image = await resultImage();
    provider.scriptResponses([
      { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
    ]);

    const [lease] = await claimJobs(client, { workerId: 'w02', kinds: ['generate'] });
    const outcome = await executeClaimedJob(executionDeps(), {
      jobId: lease!.jobId,
      workerId: 'w02',
      generationId,
    });
    expect(outcome.ok).toBe(true);

    // The provider answered but the job is not completed: state is running.
    const requested = await cancelCall(sessionA, generationId);
    expect(requested.statusCode).toBe(200);
    expect(requested.json().data).toMatchObject({
      state: 'running',
      outcome: 'cancel_requested',
      code: 'CANCEL_NOT_GUARANTEED',
    });

    // J08: a cancel request does not roll back an accepted provider call.
    await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'w02',
      generationId,
      generationState: 'succeeded',
    });
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(status.json().data.state).toBe('succeeded');
  });

  it('enforces object-level auth and refuses to cancel outcome_unknown tasks', async () => {
    const generationId = await submitQueued(sessionA);

    const asB = await cancelCall(sessionB, generationId);
    expect(asB.statusCode).toBe(403);
    expect(asB.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const missing = await cancelCall(sessionA, '00000000-0000-0000-0000-0000000000ff');
    expect(missing.statusCode).toBe(404);

    const anonymous = await cancelCall(null, generationId);
    expect(anonymous.statusCode).toBe(401);

    // Drive the task to outcome_unknown via a provider 504, then cancel → 409.
    provider.scriptResponses([{ status: 504, body: '{}' }]);
    const [lease] = await claimJobs(client, { workerId: 'w02', kinds: ['generate'] });
    const outcome = await executeClaimedJob(executionDeps(), {
      jobId: lease!.jobId,
      workerId: 'w02',
      generationId,
    });
    expect(outcome).toMatchObject({ ok: false, errorCode: 'PROVIDER_TIMEOUT_UNKNOWN' });

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(status.json().data.state).toBe('outcome_unknown');

    const refused = await cancelCall(sessionA, generationId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'GENERATION_STATE_ILLEGAL' } });
  });

  it('expired media keeps history, withdraws the download URL, and stale signatures return 410', async () => {
    const generationId = await submitQueued(sessionA);
    const image = await resultImage();
    provider.scriptResponses([
      { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
    ]);
    const [lease] = await claimJobs(client, { workerId: 'w02', kinds: ['generate'] });
    await executeClaimedJob(executionDeps(), {
      jobId: lease!.jobId,
      workerId: 'w02',
      generationId,
    });
    await completeJob(client, {
      jobId: lease!.jobId,
      workerId: 'w02',
      generationId,
      generationState: 'succeeded',
    });

    const succeeded = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    const downloadUrl = succeeded.json().meta.downloadUrl as string;
    expect(typeof downloadUrl).toBe('string');

    // Cleanup flow: media expired → generation transitions succeeded→expired.
    await client.query(
      `UPDATE media_object SET state = 'expired', expires_at = now() - interval '1 hour'
       WHERE id = (SELECT media_object_id FROM result WHERE generation_id = $1)`,
      [generationId],
    );
    await client.query(
      `UPDATE generation SET state = 'expired', updated_at = now() WHERE id = $1 AND state = 'succeeded'`,
      [generationId],
    );

    const expired = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(expired.json().data.state).toBe('expired');
    // History intact: actuals and hashes survive; only the download goes away.
    expect(expired.json().data.result).toMatchObject({
      actualWidth: 3,
      actualHeight: 2,
      sha256: createHash('sha256').update(image).digest('hex'),
    });
    expect(expired.json().meta.downloadUrl ?? null).toBeNull();

    // The previously issued signed URL is past its TTL → 410 MEDIA_EXPIRED…
    const owner = (
      await client.query<{ owner_id: string }>('SELECT owner_id FROM generation WHERE id = $1', [
        generationId,
      ])
    ).rows[0]!.owner_id;
    const { signMediaPath } = await import('../../api/src/modules/media/signed-access.js');
    const stale = signMediaPath(
      {
        bucket: 'private',
        key: `results/${generationId}.png`,
        ownerId: owner,
        method: 'GET',
        ttlSeconds: -10,
      },
      SIGNING_KEY,
    );
    const gone = await app.inject({
      method: 'GET',
      url: stale.path,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ error: { code: 'MEDIA_EXPIRED' } });

    // …and cancelling a terminal task is an idempotent no-op report.
    const terminalCancel = await cancelCall(sessionA, generationId);
    expect(terminalCancel.statusCode).toBe(200);
    expect(terminalCancel.json().data).toMatchObject({
      state: 'expired',
      outcome: 'already_terminal',
    });
  });
});

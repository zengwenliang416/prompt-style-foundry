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
import { LocalDiskStorage, type StoragePort } from '../../api/src/infra/storage/storage.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../../api/src/modules/catalog/import.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { PgSessionRepository } from '../../api/src/modules/identity/pg-session-repository.js';
import { completeJob, type Queryable } from '../src/queue.js';
import { CleanupService, DEFAULT_RETENTION_POLICY } from '../src/cleanup.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';
import { validateImage } from '../../api/src/modules/media/validate-image.js';

/**
 * O01 acceptance over real HTTP + real PG + real storage + mock provider:
 * retention expiry transitions, physical purge with deletion manifests,
 * repeated-sweep idempotency, storage-failure retry, in-flight/unknown
 * protection, signed-URL revocation, audit/task pruning, and user deletion.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SIGNING_KEY = ['o01', 'test', 'signing', 'key', 'at-least-32-characters'].join('-');
const PROVIDER_ID = 'managed-primary';
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';

const PROMPT_BODY =
  '[System / Prompt]\no01 unique prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
const PROMPT_SHA = sha256Hex(stablePromptBody(PROMPT_BODY));
const INPUT_SHA = createHash('sha256').update(PNG_1X1).digest('hex');

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: Pool;
let provider: MockProviderHandle;
let app: ReturnType<typeof buildApp>;
let storage: LocalDiskStorage;
let storageRoot = '';
let sessionA = '';
let sessionB = '';
let counter = 0;

/** Storage adapter whose remove always fails — exercises the retry channel. */
class FailingRemoveStorage implements StoragePort {
  constructor(private readonly inner: StoragePort) {}
  put(input: { bucket: string; key: string; body: Buffer }): Promise<void> {
    return this.inner.put(input);
  }
  get(input: { bucket: string; key: string }): Promise<Buffer> {
    return this.inner.get(input);
  }
  size(input: { bucket: string; key: string }): Promise<number> {
    return this.inner.size(input);
  }
  remove(): Promise<void> {
    return Promise.reject(new Error('simulated storage outage'));
  }
}

function sweep(storagePort: StoragePort = storage) {
  return new CleanupService(
    client as unknown as Queryable,
    storagePort,
    DEFAULT_RETENTION_POLICY,
  ).sweep();
}

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('retention_o01');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  provider = await startMockProvider();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'o01-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'o01-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: PROVIDER_ID,
  };
  app = buildApp(config);

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'o01-a' });
  const b = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'o01-b' });
  sessionA = (await sessions.create({ subjectId: a.id, ttlSeconds: 3600 })).token;
  sessionB = (await sessions.create({ subjectId: b.id, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'o01-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'O01 模板',
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

/** Creates an upload session and optionally drives it to a confirmed+ready input. */
async function createUpload(
  session: string,
  confirm: boolean,
): Promise<{ uploadId: string; mediaObjectId: string | null }> {
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
  if (!confirm) {
    return { uploadId, mediaObjectId: null };
  }
  const confirmed = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/confirm`,
    headers: mutateHeaders(session),
    payload: { sha256: INPUT_SHA },
  });
  return { uploadId, mediaObjectId: confirmed.json().data.mediaObjectId as string };
}

/** Full HTTP path up to a submitted (queued) generation. Returns ids. */
async function submitQueued(
  session: string,
): Promise<{ generationId: string; inputObjectId: string }> {
  const { mediaObjectId } = await createUpload(session, true);
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
    headers: { ...mutateHeaders(session), 'idempotency-key': `o01-${counter}-key` },
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
  return { generationId: submitted.json().data.id as string, inputObjectId: mediaObjectId! };
}

function executionDeps(): ExecutionDeps {
  return {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: PROVIDER_ID,
        label: 'managed mock',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-o01-secret',
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage,
    validateImage,
    providerId: PROVIDER_ID,
  };
}

async function resultImage(): Promise<Buffer> {
  return await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
}

/** Leases the pending job of exactly this generation (never steals other tests' jobs). */
async function claimFor(generationId: string): Promise<{ jobId: string }> {
  const claimed = (
    await client.query<{ id: string }>(
      `UPDATE job SET state = 'leased', lease_owner = 'o01', lease_expires_at = now() + interval '60 seconds',
              heartbeat_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM job WHERE generation_id = $1 AND state = 'pending' ORDER BY run_after LIMIT 1
       )
       RETURNING id`,
      [generationId],
    )
  ).rows[0];
  expect(claimed, `pending job for generation ${generationId}`).toBeDefined();
  return { jobId: claimed!.id };
}

/** Drives a queued generation all the way to succeeded with a real result object. */
async function succeed(generationId: string): Promise<void> {
  const image = await resultImage();
  provider.scriptResponses([
    { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
  ]);
  const lease = await claimFor(generationId);
  const outcome = await executeClaimedJob(executionDeps(), {
    jobId: lease.jobId,
    workerId: 'o01',
    generationId,
  });
  expect(outcome.ok).toBe(true);
  await completeJob(client, {
    jobId: lease.jobId,
    workerId: 'o01',
    generationId,
    generationState: 'succeeded',
  });
}

async function mediaRow(id: string) {
  return (
    await client.query<{ state: string; bucket: string; object_key: string }>(
      'SELECT state, bucket, object_key FROM media_object WHERE id = $1',
      [id],
    )
  ).rows[0];
}

async function manifestRows(mediaObjectId: string) {
  return (
    await client.query<{ reason: string }>(
      'SELECT reason FROM deletion_manifest WHERE media_object_id = $1',
      [mediaObjectId],
    )
  ).rows;
}

function deleteCall(session: string | null, generationId: string) {
  const base = { origin: ALLOWED_ORIGIN, 'x-onepic-requested-with': 'onepic-fetch' };
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/generations/${generationId}`,
    headers: session === null ? base : { ...base, cookie: `onepic_session=${session}` },
  });
}

describe('retention sweep (O01)', () => {
  it('expires incomplete uploads after 1h and purges bytes + manifest on the next sweep', async () => {
    const { uploadId } = await createUpload(sessionA, false);
    const media = (
      await client.query<{ id: string; bucket: string; object_key: string }>(
        'SELECT m.id, m.bucket, m.object_key FROM upload u JOIN media_object m ON m.id = u.media_object_id WHERE u.id = $1',
        [uploadId],
      )
    ).rows[0]!;
    // Bytes exist on disk but the session was never confirmed.
    expect(await storage.size({ bucket: media.bucket, key: media.object_key })).toBe(
      PNG_1X1.length,
    );

    await client.query(`UPDATE upload SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      uploadId,
    ]);

    const first = await sweep();
    expect(first.expiredUploads).toBe(1);
    expect((await mediaRow(media.id))!.state).toBe('expired');
    // Same-sweep purge never touches media expired in that very pass.
    expect(await manifestRows(media.id)).toHaveLength(0);

    const second = await sweep();
    expect(second.deletedMedia).toBe(1);
    expect(second.expiredUploads).toBe(0);
    expect((await mediaRow(media.id))!.state).toBe('deleted');
    expect(await manifestRows(media.id)).toMatchObject([{ reason: 'retention' }]);
    await expect(storage.get({ bucket: media.bucket, key: media.object_key })).rejects.toThrow();

    // Repeated sweeps stay idempotent: no new manifest rows, nothing deleted twice.
    const third = await sweep();
    expect(third.deletedMedia).toBe(0);
    expect(await manifestRows(media.id)).toHaveLength(1);
  });

  it('fails a purge honestly when storage remove fails, then retries on the next sweep', async () => {
    const { uploadId } = await createUpload(sessionA, false);
    const media = (
      await client.query<{ id: string }>(
        'SELECT m.id FROM upload u JOIN media_object m ON m.id = u.media_object_id WHERE u.id = $1',
        [uploadId],
      )
    ).rows[0]!;
    await client.query(`UPDATE upload SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      uploadId,
    ]);
    await sweep(); // transition to expired

    const failing = await sweep(new FailingRemoveStorage(storage));
    expect(failing.failures).toHaveLength(1);
    expect(failing.failures[0]).toMatchObject({ mediaObjectId: media.id });
    expect((await mediaRow(media.id))!.state).toBe('expired');
    expect(await manifestRows(media.id)).toHaveLength(0);

    const recovered = await sweep();
    expect(recovered.deletedMedia).toBe(1);
    expect(recovered.failures).toHaveLength(0);
    expect((await mediaRow(media.id))!.state).toBe('deleted');
    expect(await manifestRows(media.id)).toMatchObject([{ reason: 'retention' }]);
  });

  it('protects in-flight input media, expires it 24h after the task goes terminal', async () => {
    const { generationId, inputObjectId } = await submitQueued(sessionA);
    // Even with an ancient confirm timestamp, a queued generation protects its input.
    await client.query(
      `UPDATE upload SET confirmed_at = now() - interval '72 hours'
       WHERE media_object_id = $1`,
      [inputObjectId],
    );
    const protectedSweep = await sweep();
    expect(protectedSweep.expiredInputs).toBe(0);
    expect((await mediaRow(inputObjectId))!.state).toBe('ready');

    // Terminal (cancelled via the cancel endpoint, which does not touch media)
    // + 24h elapsed → the input expires.
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/generations/${generationId}/cancel`,
      headers: mutateHeaders(sessionA),
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    await client.query(
      `UPDATE generation SET completed_at = now() - interval '25 hours' WHERE id = $1`,
      [generationId],
    );
    const due = await sweep();
    expect(due.expiredInputs).toBe(1);
    expect((await mediaRow(inputObjectId))!.state).toBe('expired');
  });

  it('expires due result media, transitions succeeded→expired, and preserves history', async () => {
    const { generationId } = await submitQueued(sessionA);
    await succeed(generationId);
    const resultMediaId = (
      await client.query<{ media_object_id: string }>(
        'SELECT media_object_id FROM result WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!.media_object_id;

    await client.query(
      `UPDATE media_object SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [resultMediaId],
    );
    const report = await sweep();
    expect(report.expiredResults).toBe(1);
    expect(report.transitionedGenerations).toBe(1);
    expect((await mediaRow(resultMediaId))!.state).toBe('expired');

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(status.json().data.state).toBe('expired');
    // History intact; the download is gone.
    expect(status.json().data.result).toMatchObject({ actualWidth: 3, actualHeight: 2 });
    expect(status.json().meta.downloadUrl ?? null).toBeNull();
  });

  it('prunes audit events past 90 days and terminal task rows past 30 days', async () => {
    await client.query(
      `INSERT INTO audit_event (actor_id, action, object_type, object_id, created_at)
       VALUES (NULL, 'o01.old', 'generation', 'x', now() - interval '91 days'),
              (NULL, 'o01.new', 'generation', 'x', now() - interval '1 day')`,
    );

    const { generationId } = await submitQueued(sessionA);
    await succeed(generationId);
    const resultMediaId = (
      await client.query<{ media_object_id: string }>(
        'SELECT media_object_id FROM result WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!.media_object_id;
    // Drive the task to expired, then age it past the 30-day task window.
    await client.query(
      `UPDATE media_object SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [resultMediaId],
    );
    await client.query(
      `UPDATE generation SET completed_at = now() - interval '31 days' WHERE id = $1`,
      [generationId],
    );

    const report = await sweep();
    expect(report.prunedAuditEvents).toBe(1);
    expect(report.transitionedGenerations).toBe(1);
    expect(report.prunedGenerations).toBe(1);

    const auditActions = (
      await client.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE action LIKE 'o01.%'`,
      )
    ).rows.map((r) => r.action);
    expect(auditActions).toEqual(['o01.new']);

    for (const table of ['attempt', 'result', 'job', 'quota_ledger'] as const) {
      const rows = await client.query(`SELECT 1 FROM ${table} WHERE generation_id = $1`, [
        generationId,
      ]);
      expect(rows.rows).toHaveLength(0);
    }
    const generationRows = await client.query('SELECT 1 FROM generation WHERE id = $1', [
      generationId,
    ]);
    expect(generationRows.rows).toHaveLength(0);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('never expires media of queued/running/outcome_unknown generations, even past due', async () => {
    const queued = await submitQueued(sessionA);
    const unknown = await submitQueued(sessionA);
    provider.scriptResponses([{ status: 504, body: '{}' }]);
    const lease = await claimFor(unknown.generationId);
    const outcome = await executeClaimedJob(executionDeps(), {
      jobId: lease.jobId,
      workerId: 'o01',
      generationId: unknown.generationId,
    });
    expect(outcome).toMatchObject({ ok: false, errorCode: 'PROVIDER_TIMEOUT_UNKNOWN' });

    // Age everything far beyond the 24h input window.
    for (const id of [queued.inputObjectId, unknown.inputObjectId]) {
      await client.query(
        `UPDATE upload SET confirmed_at = now() - interval '96 hours' WHERE media_object_id = $1`,
        [id],
      );
    }
    const report = await sweep();
    expect(report.expiredInputs).toBe(0);
    expect((await mediaRow(queued.inputObjectId))!.state).toBe('ready');
    expect((await mediaRow(unknown.inputObjectId))!.state).toBe('ready');
  });
});

describe('user deletion (O01)', () => {
  it('deletes result bytes + manifest, revokes the signed URL immediately, keeps history, stays idempotent', async () => {
    const { generationId, inputObjectId } = await submitQueued(sessionA);
    await succeed(generationId);
    const resultMedia = (
      await client.query<{ media_object_id: string }>(
        'SELECT media_object_id FROM result WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!.media_object_id;
    const mediaBefore = (await mediaRow(resultMedia))!;

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    const downloadUrl = before.json().meta.downloadUrl as string;
    expect(typeof downloadUrl).toBe('string');

    const deleted = await deleteCall(sessionA, generationId);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toMatchObject({
      id: generationId,
      deleted: true,
      state: 'succeeded',
    });

    // Bytes physically gone, manifest written once with reason=user_delete.
    expect((await mediaRow(resultMedia))!.state).toBe('deleted');
    expect(await manifestRows(resultMedia)).toMatchObject([{ reason: 'user_delete' }]);
    await expect(
      storage.get({ bucket: mediaBefore.bucket, key: mediaBefore.object_key }),
    ).rejects.toThrow();
    // The unshared input media was purged too.
    expect((await mediaRow(inputObjectId))!.state).toBe('deleted');
    expect(await manifestRows(inputObjectId)).toMatchObject([{ reason: 'user_delete' }]);

    // The previously issued signed URL is revoked at once (state re-check).
    const revoked = await app.inject({
      method: 'GET',
      url: downloadUrl,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(revoked.statusCode).toBe(410);
    expect(revoked.json()).toMatchObject({ error: { code: 'MEDIA_EXPIRED' } });

    // History facts survive: state/attempt/result metadata, no download URL.
    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(after.json().data.state).toBe('succeeded');
    expect(after.json().data.result).toMatchObject({ actualWidth: 3, actualHeight: 2 });
    expect(after.json().data.attempts).toBeUndefined();
    expect(after.json().meta.downloadUrl ?? null).toBeNull();

    // Repeated delete is an idempotent 200 with no duplicate manifest rows.
    const again = await deleteCall(sessionA, generationId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ deleted: true, state: 'succeeded' });
    expect(await manifestRows(resultMedia)).toHaveLength(1);
  });

  it('cancels a queued task before deleting: job removed, quota released once', async () => {
    const { generationId } = await submitQueued(sessionA);

    const deleted = await deleteCall(sessionA, generationId);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toMatchObject({ deleted: true, state: 'cancelled' });

    // The job is dead: no worker can ever pick it up.
    const job = (
      await client.query<{ state: string; dead_reason: string | null }>(
        'SELECT state, dead_reason FROM job WHERE generation_id = $1',
        [generationId],
      )
    ).rows[0]!;
    expect(job).toMatchObject({ state: 'dead', dead_reason: 'cancelled' });
    const ledger = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM quota_ledger WHERE generation_id = $1 AND reason = 'release'`,
      [generationId],
    );
    expect(ledger.rows[0]!.n).toBe('1');
  });

  it('refuses outcome_unknown deletion (409) and enforces object-level auth', async () => {
    const { generationId } = await submitQueued(sessionA);
    provider.scriptResponses([{ status: 504, body: '{}' }]);
    const lease = await claimFor(generationId);
    await executeClaimedJob(executionDeps(), {
      jobId: lease.jobId,
      workerId: 'o01',
      generationId,
    });

    const refused = await deleteCall(sessionA, generationId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'GENERATION_STATE_ILLEGAL' } });

    const asB = await deleteCall(sessionB, generationId);
    expect(asB.statusCode).toBe(403);
    const missing = await deleteCall(sessionA, '00000000-0000-0000-0000-0000000000ff');
    expect(missing.statusCode).toBe(404);
    const anonymous = await deleteCall(null, generationId);
    expect(anonymous.statusCode).toBe(401);
  });

  it('records CANCEL_NOT_GUARANTEED when deleting a running task', async () => {
    const { generationId } = await submitQueued(sessionA);
    const image = await resultImage();
    provider.scriptResponses([
      { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
    ]);
    const lease = await claimFor(generationId);
    const outcome = await executeClaimedJob(executionDeps(), {
      jobId: lease.jobId,
      workerId: 'o01',
      generationId,
    });
    expect(outcome.ok).toBe(true);

    // Provider answered; the job is not completed: state is running.
    const deleted = await deleteCall(sessionA, generationId);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toMatchObject({
      deleted: true,
      state: 'running',
      code: 'CANCEL_NOT_GUARANTEED',
    });
    const row = (
      await client.query<{ cancel_requested_at: string | null }>(
        'SELECT cancel_requested_at FROM generation WHERE id = $1',
        [generationId],
      )
    ).rows[0]!;
    expect(row.cancel_requested_at).not.toBeNull();
  });
});

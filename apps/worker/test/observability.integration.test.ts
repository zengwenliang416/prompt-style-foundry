import http from 'node:http';
import path from 'node:path';
import { Writable } from 'node:stream';
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
import { signMediaPath } from '../../api/src/modules/media/signed-access.js';
import { completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';
import { validateImage } from '../../api/src/modules/media/validate-image.js';
import { CleanupService, DEFAULT_RETENTION_POLICY } from '../src/cleanup.js';
import {
  collectGauges,
  createMetricsHandler,
  createMetricsRegistry,
  evaluateAlerts,
  DEFAULT_ALERT_THRESHOLDS,
} from '../src/metrics.js';

/**
 * O02 acceptance over real HTTP + real PG + real storage + mock provider:
 * sentinel secrets (provider key / prompt body / signing key / session token /
 * URL signature) must not appear in ANY captured API or worker log line, in
 * raw, URL-encoded, or base64 form — while error-path logs keep their
 * correlation IDs and status codes. Also covers the metrics gauges, the
 * Prometheus text endpoint, and alert threshold triggering.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
// Sentinels: unique enough that any appearance in logs is a leak.
const SIGNING_KEY = ['o02', 'sentinel', 'signing', 'key', '7f3ac9d1'].join('-');
const PROVIDER_KEY = ['sk', 'o02-sentinel', '9f8e7d6c5b4a3f2e'].join('-');
const PROMPT_CANARY = 'o02 canary prompt body zqxwvk';
const PROVIDER_ID = 'managed-primary';
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';

const PROMPT_BODY = `[System / Prompt]\n${PROMPT_CANARY}\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n`;
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
let subjectA = '';
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
  database = await cluster.createDatabase('observability_o02');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  provider = await startMockProvider();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'o02-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    // 'info' so fastify emits per-request logs — the leak surface under test.
    logLevel: 'info',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'o02-test-oidc-client-secret',
    oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: SIGNING_KEY,
    mediaStorageRoot: storageRoot,
    managedProviderId: PROVIDER_ID,
  };
  app = buildApp(config, { logStream: new CaptureStream() });

  const sessions = new PgSessionRepository(client);
  const a = await sessions.upsertSubject({ issuer: 'https://id.test', subjectClaim: 'o02-a' });
  subjectA = a.id;
  sessionA = (await sessions.create({ subjectId: a.id, ttlSeconds: 3600 })).token;

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'o02-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'O02 模板',
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

async function submitQueued(): Promise<string> {
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
  const submitted = await app.inject({
    method: 'POST',
    url: '/api/v1/generations',
    headers: { ...mutateHeaders(sessionA), 'idempotency-key': `o02-${counter}-key` },
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
        apiKey: PROVIDER_KEY,
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage,
    validateImage,
    providerId: PROVIDER_ID,
  };
}

async function claimFor(generationId: string): Promise<{ jobId: string }> {
  const claimed = (
    await client.query<{ id: string }>(
      `UPDATE job SET state = 'leased', lease_owner = 'o02', lease_expires_at = now() + interval '60 seconds',
              heartbeat_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM job WHERE generation_id = $1 AND state = 'pending' ORDER BY run_after LIMIT 1
       )
       RETURNING id`,
      [generationId],
    )
  ).rows[0];
  expect(claimed).toBeDefined();
  return { jobId: claimed!.id };
}

describe('sentinel leak sweep across the full chain (O02)', () => {
  it('runs upload → success → download → failure → cancel → delete → retention with zero sentinel leakage', async () => {
    // Success path + signed download (the signature enters request logs).
    const okId = await submitQueued();
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    provider.scriptResponses([
      { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
    ]);
    let lease = await claimFor(okId);
    await executeClaimedJob(executionDeps(), {
      jobId: lease.jobId,
      workerId: 'o02',
      generationId: okId,
    });
    await completeJob(client, {
      jobId: lease.jobId,
      workerId: 'o02',
      generationId: okId,
      generationState: 'succeeded',
    });

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${okId}`,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    const downloadUrl = status.json().meta.downloadUrl as string;
    const signatureSentinel = new URL(downloadUrl, 'http://x').searchParams.get('signature')!;
    expect(signatureSentinel.length).toBeGreaterThan(10);
    const download = await app.inject({
      method: 'GET',
      url: downloadUrl,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(download.statusCode).toBe(200);

    // Failure path: provider 500 logs an error code (never the key/body).
    const failId = await submitQueued();
    provider.scriptResponses([{ status: 500, body: '{"error":"upstream"}' }]);
    lease = await claimFor(failId);
    const failed = await executeClaimedJob(executionDeps(), {
      jobId: lease.jobId,
      workerId: 'o02',
      generationId: failId,
    });
    expect(failed.ok).toBe(false);

    // Cancel path.
    const cancelId = await submitQueued();
    await app.inject({
      method: 'POST',
      url: `/api/v1/generations/${cancelId}/cancel`,
      headers: mutateHeaders(sessionA),
      payload: {},
    });

    // Delete path (purges the result media of the succeeded task).
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/generations/${okId}`,
      headers: mutateHeaders(sessionA),
    });
    expect(deleted.statusCode).toBe(200);

    // Internal-error path: DB says ready, bytes are gone → 500 + correlationId.
    const orphanKey = `${subjectA}/o02-orphan.png`;
    await client.query(
      `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, mime, expires_at)
       VALUES ($1, 'result', 'ready', 'private', $2, $3, 'image/png', now() + interval '1 day')`,
      [subjectA, orphanKey, 'b'.repeat(64)],
    );
    const orphanSigned = signMediaPath(
      { bucket: 'private', key: orphanKey, ownerId: subjectA, method: 'GET', ttlSeconds: 300 },
      SIGNING_KEY,
    );
    const orphan = await app.inject({
      method: 'GET',
      url: orphanSigned.path,
      headers: { cookie: `onepic_session=${sessionA}` },
    });
    expect(orphan.statusCode).toBe(500);

    // Retention sweep with a failing storage remove (worker-side path).
    await client.query(`UPDATE media_object SET state = 'expired' WHERE object_key = $1`, [
      orphanKey,
    ]);
    const failing = await new CleanupService(
      client as unknown as Queryable,
      {
        remove: () => Promise.reject(new Error(`storage offline near ${PROVIDER_KEY}`)),
      },
      DEFAULT_RETENTION_POLICY,
    ).sweep();
    expect(failing.failures.length).toBeGreaterThan(0);
    await new CleanupService(
      client as unknown as Queryable,
      storage,
      DEFAULT_RETENTION_POLICY,
    ).sweep();

    // ── Sentinel assertions over every captured API log line ──
    expect(logLines.length).toBeGreaterThan(10);
    const sentinels = [SIGNING_KEY, PROVIDER_KEY, PROMPT_CANARY, sessionA, signatureSentinel];
    for (const line of logLines) {
      for (const sentinel of sentinels) {
        expect(line).not.toContain(sentinel);
        expect(line).not.toContain(encodeURIComponent(sentinel));
        expect(line).not.toContain(Buffer.from(sentinel).toString('base64'));
      }
    }
    // The signed download's request log kept the path but redacted the signature.
    const mediaLogs = logLines.filter((line) => line.includes('/api/v1/media/'));
    expect(mediaLogs.length).toBeGreaterThan(0);
    expect(
      mediaLogs.every(
        (line) => !line.includes('signature=') || line.includes('signature=[redacted]'),
      ),
    ).toBe(true);

    // ── Redaction is not over-broad: error-path logs keep their signal ──
    const internalError = logLines.find((line) => line.includes('internal_error'));
    expect(internalError).toBeDefined();
    expect(internalError).toContain('correlationId');
    expect(internalError).toContain(orphan.json().error.correlationId);
    const completed = logLines.filter((line) => line.includes('request completed'));
    expect(completed.some((line) => line.includes('"statusCode":500'))).toBe(true);
    expect(completed.some((line) => line.includes('"statusCode":200'))).toBe(true);
    expect(completed.every((line) => line.includes('reqId'))).toBe(true);
  });
});

describe('metrics + alert thresholds (O02)', () => {
  it('reports queue age, unknown count, and purge backlog; alerts fire past thresholds', async () => {
    const db = client as unknown as Queryable;
    const before = await collectGauges(db);
    const beforeUnknown = before.find(
      (g) => g.name === 'onepic_generations_outcome_unknown',
    )!.value;
    const beforePurge = before.find((g) => g.name === 'onepic_media_pending_purge')!.value;

    // Seed: a pending job aged 600s, one outcome_unknown generation, one expired media.
    const stuckId = await submitQueued();
    await client.query(
      `UPDATE job SET created_at = now() - interval '600 seconds', run_after = now() - interval '600 seconds'
       WHERE generation_id = $1`,
      [stuckId],
    );
    const unknownId = await submitQueued();
    provider.scriptResponses([{ status: 504, body: '{}' }]);
    const lease = await claimFor(unknownId);
    await executeClaimedJob(executionDeps(), {
      jobId: lease.jobId,
      workerId: 'o02',
      generationId: unknownId,
    });
    await client.query(
      `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
       VALUES ($1, 'result', 'expired', 'private', $2, $3, now())`,
      [subjectA, `${subjectA}/o02-backlog.png`, 'c'.repeat(64)],
    );

    const gauges = await collectGauges(db);
    const queueAge = gauges.find((g) => g.name === 'onepic_queue_oldest_pending_age_seconds');
    expect(queueAge).toBeDefined();
    expect(queueAge!.value).toBeGreaterThanOrEqual(590);
    expect(queueAge!.labels).toEqual({ kind: 'generate' });
    expect(gauges.find((g) => g.name === 'onepic_generations_outcome_unknown')!.value).toBe(
      beforeUnknown + 1,
    );
    expect(gauges.find((g) => g.name === 'onepic_media_pending_purge')!.value).toBe(
      beforePurge + 1,
    );

    const alerts = evaluateAlerts(
      { gauges, registry: createMetricsRegistry() },
      DEFAULT_ALERT_THRESHOLDS,
    );
    expect(alerts.map((a) => a.alert)).toEqual(
      expect.arrayContaining(['QUEUE_STUCK', 'OUTCOME_UNKNOWN_PENDING', 'PURGE_BACKLOG']),
    );

    // Quiet system → no alerts.
    const quiet = await collectGauges(db);
    const calm = evaluateAlerts(
      {
        gauges: quiet.map((g) =>
          g.name === 'onepic_queue_oldest_pending_age_seconds' ? { ...g, value: 10 } : g,
        ),
        registry: createMetricsRegistry(),
      },
      {
        ...DEFAULT_ALERT_THRESHOLDS,
        outcomeUnknownCount: Number.MAX_SAFE_INTEGER,
        mediaPendingPurgeCount: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(calm).toEqual([]);
  });

  it('serves the Prometheus text endpoint on the internal ops server only', async () => {
    const registry = createMetricsRegistry();
    const handler = createMetricsHandler({ db: client as unknown as Queryable, registry });
    const server = http.createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      const body = await metrics.text();
      expect(body).toContain('# TYPE onepic_queue_oldest_pending_age_seconds gauge');
      expect(body).toContain('onepic_generations_outcome_unknown');
      expect(body).toContain('onepic_media_pending_purge');
      // No sentinel values in the exposition either.
      expect(body).not.toContain(PROVIDER_KEY);
      expect(body).not.toContain(PROMPT_CANARY);

      const notFound = await fetch(`http://127.0.0.1:${port}/api/v1/generations`);
      expect(notFound.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

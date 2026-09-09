#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from 'pg';
import sharp from 'sharp';
import { startPgTestCluster } from '@onepic/test-support';
import { ProviderAdapter, LocalDiskStorage, validateImage } from '@onepic/managed-runtime';

import { buildApp } from '../apps/api/dist/bootstrap/app.js';
import { runMigrations } from '../apps/api/dist/db/migrate.js';
import { importCatalogRelease } from '../apps/api/dist/modules/catalog/import.js';
import { PgSessionRepository } from '../apps/api/dist/modules/identity/pg-session-repository.js';
import { claimJobs, completeJob } from '../apps/worker/dist/queue.js';
import { executeClaimedJob } from '../apps/worker/dist/execute.js';

const ROOT = process.cwd();
const AUTHORIZATION_GUARD = 'YES_ONE_REQUEST';
const ALLOWED_ORIGIN = 'http://127.0.0.1:9999';
const TEMPLATE_ID = process.env.ONEPIC_W06_TEMPLATE_ID ?? 'case-409';
const REPORT_PATH = path.resolve(
  process.env.ONEPIC_W06_REPORT ?? 'docs/design/evidence/w06/real-provider-report.json',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readProviderEnv(file) {
  const values = {};
  for (const line of file.split(/\r?\n/)) {
    if (line === '' || line.trimStart().startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  for (const key of [
    'WORKER_PROVIDER_ID',
    'WORKER_PROVIDER_BASE_URL',
    'WORKER_PROVIDER_API_KEY',
    'WORKER_PROVIDER_MODELS',
  ]) {
    assert(values[key], `${key} is required in the W06 provider env file`);
  }
  const [modelEntry] = values.WORKER_PROVIDER_MODELS.split(',');
  const [model, qualitiesRaw] = modelEntry.split(':');
  const qualities = (qualitiesRaw ?? '').split('+').filter(Boolean);
  assert(model && qualities.length > 0, 'WORKER_PROVIDER_MODELS must contain model:quality');
  const base = new URL(values.WORKER_PROVIDER_BASE_URL);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  const loopbackTestAllowed =
    process.env.ONEPIC_W06_ALLOW_LOOPBACK_TEST === 'true' && base.protocol === 'http:' && loopback;
  assert(
    base.protocol === 'https:' || loopbackTestAllowed,
    'real Provider base URL must use HTTPS',
  );
  assert(base.pathname === '/' || base.pathname === '', 'Provider base URL must be an origin');
  return {
    providerId: values.WORKER_PROVIDER_ID,
    baseUrl: base.origin,
    apiKey: values.WORKER_PROVIDER_API_KEY,
    model,
    quality: qualities[0],
    qualities,
  };
}

function mutationHeaders(session) {
  return {
    origin: ALLOWED_ORIGIN,
    'x-onepic-requested-with': 'onepic-fetch',
    cookie: `onepic_session=${session}`,
  };
}

async function main() {
  assert(
    process.env.ONEPIC_W06_PAID_AUTHORIZED === AUTHORIZATION_GUARD,
    `refusing paid call without ONEPIC_W06_PAID_AUTHORIZED=${AUTHORIZATION_GUARD}`,
  );
  const envPath = path.resolve(process.env.ONEPIC_W06_PROVIDER_ENV ?? '.tmp/w06-provider.env');
  const provider = readProviderEnv(await readFile(envPath, 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'public/data/catalog.json'), 'utf8'));
  const template = catalog.templates.find((entry) => entry.id === TEMPLATE_ID);
  assert(template, `template ${TEMPLATE_ID} not found`);
  assert(template.kind === 'case', 'W06 requires a case template');
  assert(template.requiresText === false, 'W06 template must not require text');
  assert(template.blueprintInputMode === 'image-to-image', 'W06 template must be image-to-image');
  const prompt = await readFile(path.join(ROOT, 'public', template.promptPath), 'utf8');
  assert(
    sha256(Buffer.from(prompt.replace(/\n+$/, ''), 'utf8')) === template.promptSha256,
    'prompt hash drift',
  );

  let cluster;
  let database;
  let client;
  let app;
  let storageRoot;
  let providerCalls = 0;
  const startedAt = new Date().toISOString();
  let report;

  try {
    cluster = await startPgTestCluster();
    database = await cluster.createDatabase('w06_real_provider');
    await runMigrations(database.uri);
    client = new Client({ connectionString: database.uri });
    await client.connect();
    await importCatalogRelease({ client, rootDir: ROOT });

    storageRoot = await mkdtemp(path.join(tmpdir(), 'onepic-w06-media-'));
    const sessionSecret = ['w06', randomUUID(), randomUUID()].join('-');
    app = buildApp({
      host: '127.0.0.1',
      port: 0,
      logLevel: 'fatal',
      runMode: 'managed-generation',
      databaseUrl: database.uri,
      oidcIssuer: 'https://id.w06.invalid',
      oidcClientId: 'onepic-w06',
      oidcClientSecret: 'w06-local-oidc-client-secret',
      oidcRedirectUri: `${ALLOWED_ORIGIN}/api/v1/auth/callback`,
      sessionSecret,
      mediaStorageRoot: storageRoot,
      managedProviderId: provider.providerId,
      generationQuotaLimit: 1,
    });
    await app.ready();

    const sessions = new PgSessionRepository(client);
    const subject = await sessions.upsertSubject({
      issuer: 'https://id.w06.invalid',
      subjectClaim: `w06-${randomUUID()}`,
    });
    const session = (await sessions.create({ subjectId: subject.id, ttlSeconds: 3600 })).token;

    const inputImage = await sharp({
      create: { width: 512, height: 320, channels: 3, background: '#f6f0df' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 180, height: 180, channels: 4, background: '#ef4444' },
          })
            .png()
            .toBuffer(),
          left: 42,
          top: 70,
        },
        {
          input: await sharp({
            create: { width: 180, height: 110, channels: 4, background: '#2563eb' },
          })
            .png()
            .toBuffer(),
          left: 285,
          top: 105,
        },
      ])
      .png()
      .toBuffer();
    const inputMeta = await sharp(inputImage).metadata();
    const inputSha256 = sha256(inputImage);

    const uploadCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: mutationHeaders(session),
      payload: { declaredBytes: inputImage.length, declaredMime: 'image/png' },
    });
    assert(uploadCreated.statusCode === 201, `upload create failed: ${uploadCreated.statusCode}`);
    const uploadId = uploadCreated.json().data.uploadId;

    const uploaded = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/bytes`,
      headers: { ...mutationHeaders(session), 'content-type': 'application/octet-stream' },
      payload: inputImage,
    });
    assert(uploaded.statusCode === 200, `upload bytes failed: ${uploaded.statusCode}`);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/confirm`,
      headers: mutationHeaders(session),
      payload: { sha256: inputSha256 },
    });
    assert(confirmed.statusCode === 200, `upload confirm failed: ${confirmed.statusCode}`);
    const sourceObjectId = confirmed.json().data.mediaObjectId;

    const settings = { model: provider.model, quality: provider.quality };
    const precheck = await app.inject({
      method: 'POST',
      url: '/api/v1/prechecks',
      headers: mutationHeaders(session),
      payload: { templateId: TEMPLATE_ID, templateVersion: 1, sourceObjectId, settings },
    });
    assert(precheck.statusCode === 201, `precheck failed: ${precheck.statusCode}`);
    const precheckId = precheck.json().data.precheckId;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/generations',
      headers: { ...mutationHeaders(session), 'idempotency-key': `w06-${randomUUID()}` },
      payload: {
        templateId: TEMPLATE_ID,
        templateVersion: 1,
        promptSha256: template.promptSha256,
        sourceObjectId,
        precheckId,
        settings,
      },
    });
    assert(created.statusCode === 202, `generation create failed: ${created.statusCode}`);
    const generationId = created.json().data.id;

    const [lease] = await claimJobs(client, { workerId: 'w06-real', kinds: ['generate'] });
    assert(lease?.generationId === generationId, 'W06 generation job was not claimed');
    const countedFetch = async (...args) => {
      providerCalls += 1;
      if (providerCalls > 1) throw new Error('W06 single-request budget exceeded');
      return await fetch(...args);
    };
    const adapter = new ProviderAdapter(
      {
        providerId: provider.providerId,
        label: 'W06 real provider',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        models: [{ id: provider.model, qualities: provider.qualities }],
      },
      { fetchImpl: countedFetch },
    );
    const outcome = await executeClaimedJob(
      {
        db: client,
        adapter,
        storage: new LocalDiskStorage(storageRoot),
        validateImage,
        providerId: provider.providerId,
      },
      { jobId: lease.jobId, workerId: 'w06-real', generationId },
    );
    assert(providerCalls === 1, `expected exactly one Provider request, got ${providerCalls}`);
    assert(outcome.ok, `Provider execution failed: ${outcome.errorCode}`);
    const completion = await completeJob(client, {
      jobId: lease.jobId,
      workerId: 'w06-real',
      generationId,
      generationState: 'succeeded',
    });
    assert(completion.completed, 'job completion CAS failed');

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}`,
      headers: { cookie: `onepic_session=${session}` },
    });
    assert(
      statusResponse.statusCode === 200,
      `generation query failed: ${statusResponse.statusCode}`,
    );
    const status = statusResponse.json();
    assert(status.data.state === 'succeeded', `unexpected generation state: ${status.data.state}`);
    assert(typeof status.meta.downloadUrl === 'string', 'download URL missing');

    const download = await app.inject({
      method: 'GET',
      url: status.meta.downloadUrl,
      headers: { cookie: `onepic_session=${session}` },
    });
    assert(download.statusCode === 200, `result download failed: ${download.statusCode}`);
    const resultBytes = download.rawPayload;
    const resultSha256 = sha256(resultBytes);
    const resultMeta = await sharp(resultBytes).metadata();
    assert((resultMeta.width ?? 0) > 0 && (resultMeta.height ?? 0) > 0, 'result pixels invalid');
    assert(status.data.result.sha256 === resultSha256, 'generation result hash mismatch');
    assert(
      status.data.result.actualBytes === resultBytes.length,
      'generation result byte count mismatch',
    );
    assert(status.data.result.actualWidth === resultMeta.width, 'generation result width mismatch');
    assert(
      status.data.result.actualHeight === resultMeta.height,
      'generation result height mismatch',
    );

    const sidecarResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/generations/${generationId}/sidecar`,
      headers: { cookie: `onepic_session=${session}` },
    });
    assert(
      sidecarResponse.statusCode === 200,
      `sidecar query failed: ${sidecarResponse.statusCode}`,
    );
    const sidecar = sidecarResponse.json().data;
    assert(sidecar.input.sha256 === inputSha256, 'sidecar input hash mismatch');
    assert(sidecar.prompt.compiledSha256 === template.promptSha256, 'sidecar prompt hash mismatch');
    assert(
      sidecar.prompt.effectiveSha256 === template.promptSha256,
      'sidecar effective prompt hash mismatch',
    );
    assert(sidecar.result.sha256 === resultSha256, 'sidecar result hash mismatch');

    report = {
      schemaVersion: '1.0.0',
      verifiedAt: new Date().toISOString(),
      startedAt,
      result: 'PASS',
      authorization: { maximumChargeableRequests: 1, providerRequests: providerCalls },
      provider: {
        providerId: provider.providerId,
        baseOrigin: provider.baseUrl,
        model: provider.model,
        quality: provider.quality,
      },
      template: { id: TEMPLATE_ID, version: 1, promptSha256: template.promptSha256 },
      input: {
        mime: 'image/png',
        bytes: inputImage.length,
        width: inputMeta.width,
        height: inputMeta.height,
        sha256: inputSha256,
      },
      output: {
        mime: status.data.result.actualMime,
        bytes: resultBytes.length,
        width: resultMeta.width,
        height: resultMeta.height,
        orientation: resultMeta.orientation ?? 1,
        sha256: resultSha256,
        decoded: true,
        sourceAspectRatio: inputMeta.width / inputMeta.height,
        outputAspectRatio: resultMeta.width / resultMeta.height,
        aspectRatioRelativeDelta:
          Math.abs(resultMeta.width / resultMeta.height - inputMeta.width / inputMeta.height) /
          (inputMeta.width / inputMeta.height),
        orientationPreserved:
          inputMeta.width >= inputMeta.height === resultMeta.width >= resultMeta.height,
      },
      traceability: {
        generationId,
        sidecarSchemaVersion: sidecar.schemaVersion,
        sidecarKind: sidecar.kind,
        inputHashMatches: true,
        promptHashMatches: true,
        resultHashMatches: true,
        downloadedBytesMatch: true,
      },
      boundaries: {
        providerApiKeyStoredOnlyInIgnoredLocalEnv: true,
        providerApiKeyIncludedInReport: false,
        providerApiKeyLogged: false,
        productionMigration: false,
        deployment: false,
      },
    };
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ event: 'w06_real_provider_passed', report: REPORT_PATH, providerCalls })}\n`,
    );
  } catch (error) {
    report = {
      schemaVersion: '1.0.0',
      verifiedAt: new Date().toISOString(),
      startedAt,
      result: 'FAIL',
      authorization: { maximumChargeableRequests: 1, providerRequests: providerCalls },
      error: error instanceof Error ? error.message : 'unknown error',
      boundaries: {
        providerApiKeyStoredOnlyInIgnoredLocalEnv: true,
        providerApiKeyIncludedInReport: false,
        providerApiKeyLogged: false,
        productionMigration: false,
        deployment: false,
      },
    };
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    await app?.close().catch(() => undefined);
    await client?.end().catch(() => undefined);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    await database?.drop().catch(() => undefined);
    await cluster?.stop().catch(() => undefined);
  }
}

await main();

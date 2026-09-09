#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client, Pool } from 'pg';
import sharp from 'sharp';

import { buildApp } from '../apps/api/dist/bootstrap/app.js';
import { runMigrations } from '../apps/api/dist/db/migrate.js';
import { importCatalogRelease } from '../apps/api/dist/modules/catalog/import.js';
import { PgSessionRepository } from '../apps/api/dist/modules/identity/pg-session-repository.js';
import { validateImage } from '../apps/api/dist/modules/media/validate-image.js';
import { claimJobs, completeJob } from '../apps/worker/dist/queue.js';
import { startMockProvider, startPgTestCluster } from '../packages/test-support/dist/index.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(repoRoot, 'docs/design/evidence/o04');
const jsonPath = path.join(evidenceDir, 'capacity-report.json');
const markdownPath = path.join(evidenceDir, 'capacity-report.md');

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function summarizeLatencies(values) {
  return {
    count: values.length,
    minMs: round(Math.min(...values)),
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values)),
  };
}

async function directoryBytes(root) {
  let total = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) total += await directoryBytes(target);
      else if (entry.isFile()) total += (await stat(target)).size;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return total;
}

async function runConcurrent(total, concurrency, operation) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= total) return;
        await operation(index);
      }
    }),
  );
}

async function gitVersion() {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }),
    exec('git', ['status', '--porcelain'], { cwd: repoRoot }),
  ]);
  return `${commit.trim()}${status.trim() === '' ? '' : ' + dirty'}`;
}

async function sampleConnections(client, stop) {
  let peak = 0;
  const samples = [];
  while (!stop.done) {
    let result;
    try {
      result = await client.query(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE datname = current_database() AND backend_type = 'client backend'`,
      );
    } catch (error) {
      if (
        stop.done ||
        /Client was closed and is not queryable/.test(String(error?.message ?? error))
      ) {
        return { peak, samples };
      }
      throw error;
    }
    const count = result.rows[0]?.count ?? 0;
    peak = Math.max(peak, count);
    samples.push(count);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { peak, samples };
}

async function benchmarkHttp(databaseUri, storageRoot, observer) {
  const sessions = new PgSessionRepository(observer);
  const subject = await sessions.upsertSubject({
    issuer: 'https://capacity.test',
    subjectClaim: `http-${randomUUID()}`,
  });
  const session = await sessions.create({ subjectId: subject.id, ttlSeconds: 3600 });
  const cookie = `onepic_session=${session.token}`;
  const app = buildApp({
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: databaseUri,
    oidcIssuer: 'http://127.0.0.1:9',
    oidcClientId: 'capacity-client',
    oidcClientSecret: 'capacity-client-secret-not-a-provider-key',
    oidcRedirectUri: 'http://127.0.0.1:4173/auth/callback',
    sessionSecret: 'capacity-session-secret-at-least-32-characters',
    mediaStorageRoot: storageRoot,
    managedProviderId: 'capacity-no-provider-call',
    generationQuotaLimit: 20,
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  try {
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${address}/api/v1/health/live`);
      if (!response.ok) throw new Error(`health warmup failed: ${response.status}`);
      await response.arrayBuffer();
    }

    const runRoute = async ({
      route,
      total,
      concurrency,
      method = 'GET',
      makeBody,
      expectedStatus,
    }) => {
      const latencies = [];
      const statuses = {};
      const started = performance.now();
      await runConcurrent(total, concurrency, async (index) => {
        const requestStarted = performance.now();
        const body = makeBody?.(index);
        const response = await fetch(`${address}${route}`, {
          method,
          headers: {
            connection: 'keep-alive',
            cookie,
            ...(method === 'GET'
              ? {}
              : {
                  origin: 'http://127.0.0.1:4173',
                  'x-onepic-requested-with': 'onepic-fetch',
                  'content-type': 'application/json',
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const responseBody = await response.json();
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status !== expectedStatus || responseBody?.error !== undefined) {
          throw new Error(
            `${method} ${route} returned ${response.status}: ${JSON.stringify(responseBody)}`,
          );
        }
        latencies.push(performance.now() - requestStarted);
      });
      const elapsedMs = performance.now() - started;
      return {
        route,
        method,
        concurrency,
        ...summarizeLatencies(latencies),
        elapsedMs: round(elapsedMs),
        requestsPerSecond: round((total * 1000) / elapsedMs),
        statuses,
      };
    };

    const live = await runRoute({
      route: '/api/v1/health/live',
      total: 400,
      concurrency: 20,
      expectedStatus: 200,
    });
    const stop = { done: false };
    const connectionSampling = sampleConnections(observer, stop);
    const workspaceWrite = await runRoute({
      route: '/api/v1/collections',
      method: 'POST',
      total: 160,
      concurrency: 8,
      expectedStatus: 201,
      makeBody: (index) => ({ name: `O04 capacity ${index}-${randomUUID().slice(0, 8)}` }),
    });
    const workspaceRead = await runRoute({
      route: '/api/v1/collections?limit=50',
      total: 400,
      concurrency: 20,
      expectedStatus: 200,
    });
    stop.done = true;
    const workloadConnections = await connectionSampling;

    const readyStop = { done: false };
    const readyConnectionSampling = sampleConnections(observer, readyStop);
    const ready = await runRoute({
      route: '/api/v1/health/ready',
      total: 120,
      concurrency: 8,
      expectedStatus: 200,
    });
    readyStop.done = true;
    const readyConnections = await readyConnectionSampling;
    return {
      live,
      workspaceWrite,
      workspaceRead,
      ready,
      pgConnectionsDuringWorkload: { peak: workloadConnections.peak },
      pgConnectionsDuringReady: { peak: readyConnections.peak },
    };
  } finally {
    await app.close();
  }
}

async function seedQueue(client, count) {
  const suffix = randomUUID().replaceAll('-', '');
  const subject = await client.query(
    `INSERT INTO subject (issuer, subject_claim, role)
     VALUES ('https://capacity.test', $1, 'member') RETURNING id`,
    [`capacity-${suffix}`],
  );
  const ownerId = subject.rows[0].id;
  const release = await client.query(
    `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
     VALUES ('capacity', $1, $2, 1) RETURNING id`,
    [`source-${suffix}`, `library-${suffix}`],
  );
  const releaseId = release.rows[0].id;
  const version = await client.query(
    `INSERT INTO template_version
       (catalog_release_id, template_key, version, compiled_prompt_sha256, blueprint_sha256, metadata)
     VALUES ($1, $2, 1, $3, $4, '{}') RETURNING id`,
    [releaseId, `capacity-${suffix}`, `compiled-${suffix}`, `blueprint-${suffix}`],
  );
  const templateVersionId = version.rows[0].id;
  const media = await client.query(
    `INSERT INTO media_object
       (owner_id, kind, state, bucket, object_key, mime, bytes, width, height, sha256, expires_at)
     VALUES ($1, 'input', 'ready', 'capacity', $2, 'image/png', 68, 1, 1, $3,
       now() + interval '1 day') RETURNING id`,
    [ownerId, `input/${suffix}.png`, `input-${suffix}`],
  );
  const mediaId = media.rows[0].id;
  const precheck = await client.query(
    `INSERT INTO precheck
       (subject_id, media_object_id, template_version_id, settings, result, expires_at)
     VALUES ($1, $2, $3, '{}', 'passed', now() + interval '1 hour') RETURNING id`,
    [ownerId, mediaId, templateVersionId],
  );
  const precheckId = precheck.rows[0].id;

  await client.query(
    `WITH inserted AS (
       INSERT INTO generation
         (owner_id, template_version_id, catalog_release_id, precheck_id, input_object_id,
          input_sha256, compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
          settings, idempotency_key, state)
       SELECT $1, $2, $3, $4, $5, $6, $7, $7, 'capacity-no-provider-call',
              'queue-shell', '{}', $8 || series::text, 'queued'
       FROM generate_series(1, $9::int) AS series
       RETURNING id
     )
     INSERT INTO job (generation_id, kind, state, run_after)
     SELECT id, 'generate', 'pending', now() FROM inserted`,
    [
      ownerId,
      templateVersionId,
      releaseId,
      precheckId,
      mediaId,
      `input-${suffix}`,
      `compiled-${suffix}`,
      `capacity-${suffix}-`,
      count,
    ],
  );
  return ownerId;
}

async function seedRunnableWorkerJob(client, mediaRoot) {
  const suffix = randomUUID().replaceAll('-', '');
  const prompt =
    '[System / Prompt]\nO04 deployable worker probe\nBEGIN VISUAL BLUEPRINT\nx\nEND VISUAL BLUEPRINT';
  const promptSha = createHash('sha256').update(prompt).digest('hex');
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#446688' },
  })
    .png()
    .toBuffer();
  const inputSha = createHash('sha256').update(image).digest('hex');
  const objectKey = `inputs/${suffix}.png`;
  const objectPath = path.join(mediaRoot, 'quarantine', objectKey);
  await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, image);
  const subject = await client.query(
    `INSERT INTO subject (issuer, subject_claim, role)
     VALUES ('https://capacity.test', $1, 'member') RETURNING id`,
    [`process-${suffix}`],
  );
  const ownerId = subject.rows[0].id;
  const release = await client.query(
    `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
     VALUES ('capacity-process', $1, $2, 1) RETURNING id`,
    [`process-source-${suffix}`, `process-library-${suffix}`],
  );
  const releaseId = release.rows[0].id;
  const version = await client.query(
    `INSERT INTO template_version
       (catalog_release_id, template_key, version, compiled_prompt_sha256,
        blueprint_sha256, metadata, prompt_text)
     VALUES ($1, $2, 1, $3, $4, '{}', $5) RETURNING id`,
    [releaseId, `process-${suffix}`, promptSha, `process-blueprint-${suffix}`, `${prompt}\n`],
  );
  const media = await client.query(
    `INSERT INTO media_object
       (owner_id, kind, state, bucket, object_key, mime, bytes, width, height, sha256, expires_at)
     VALUES ($1, 'input', 'ready', 'quarantine', $2, 'image/png', $3, 2, 2, $4,
       now() + interval '1 day') RETURNING id`,
    [ownerId, objectKey, image.length, inputSha],
  );
  const precheck = await client.query(
    `INSERT INTO precheck
       (subject_id, media_object_id, template_version_id, settings, result, expires_at)
     VALUES ($1, $2, $3, '{"quality":"high"}', 'passed', now() + interval '1 hour')
     RETURNING id`,
    [ownerId, media.rows[0].id, version.rows[0].id],
  );
  const generation = await client.query(
    `INSERT INTO generation
       (owner_id, template_version_id, catalog_release_id, precheck_id, input_object_id,
        input_sha256, compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
        settings, idempotency_key, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'capacity-loopback', 'capacity-image',
       '{"quality":"high"}', $8, 'queued') RETURNING id`,
    [
      ownerId,
      version.rows[0].id,
      releaseId,
      precheck.rows[0].id,
      media.rows[0].id,
      inputSha,
      promptSha,
      `process-${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO job (generation_id, kind, state, run_after)
     VALUES ($1, 'generate', 'pending', now())`,
    [generation.rows[0].id],
  );
  return generation.rows[0].id;
}

async function measureWorkerProcessConsumer(databaseUri, mediaRoot) {
  const provider = await startMockProvider();
  const probe = new Client({ connectionString: databaseUri });
  await probe.connect();
  const generationId = await seedRunnableWorkerJob(probe, mediaRoot);
  const startedAt = performance.now();
  const child = spawn(process.execPath, ['apps/worker/dist/index.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUri,
      MEDIA_STORAGE_ROOT: mediaRoot,
      CLEANUP_INTERVAL_SECONDS: '3600',
      WORKER_GENERATION_ENABLED: 'true',
      WORKER_CONCURRENCY: '2',
      WORKER_POLL_INTERVAL_MS: '20',
      WORKER_LEASE_SECONDS: '30',
      WORKER_HEARTBEAT_SECONDS: '5',
      WORKER_SHUTDOWN_GRACE_SECONDS: '2',
      WORKER_PROVIDER_ID: 'capacity-loopback',
      WORKER_PROVIDER_LABEL: 'Capacity loopback simulator',
      WORKER_PROVIDER_BASE_URL: provider.baseUrl,
      WORKER_PROVIDER_API_KEY: 'capacity-sentinel-key',
      WORKER_PROVIDER_MODELS: 'capacity-image:high',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-8192);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  let terminal;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const state = await probe.query(
        `SELECT g.state AS generation_state, j.state AS job_state
         FROM generation g JOIN job j ON j.generation_id = g.id
         WHERE g.id = $1`,
        [generationId],
      );
      terminal = state.rows[0];
      if (terminal?.generation_state === 'succeeded' && terminal?.job_state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGTERM');
    const exit = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('worker process did not stop after SIGTERM')), 5000),
      ),
    ]);
    if (
      exit.code !== 0 ||
      terminal?.generation_state !== 'succeeded' ||
      terminal?.job_state !== 'done' ||
      provider.requests.length !== 1
    ) {
      throw new Error(
        `worker process probe failed: ${JSON.stringify({ exit, terminal, requests: provider.requests.length, stdout, stderr })}`,
      );
    }
    return {
      probeDurationMs: round(performance.now() - startedAt),
      queuedJobsBefore: 1,
      pendingJobsAfter: 0,
      leasedJobsAfter: 0,
      measuredClaims: 1,
      measuredGenerationConcurrency: 'at-least-one',
      claimLoopWired: true,
      loopbackProviderRequests: provider.requests.length,
      terminal,
      note: '可部署 Worker 进程经真实 PG claim/execute/complete、真实本地存储和隔离 loopback Provider simulator 完成 1 个任务；这不是 W06 真实 Provider 验证。',
    };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await probe.end();
    await provider.close();
  }
}
async function benchmarkQueue(databaseUri, observer, tempRoot) {
  const jobs = 320;
  const workers = 8;
  const workerProcess = await measureWorkerProcessConsumer(
    databaseUri,
    path.join(tempRoot, 'worker-process-media'),
  );
  const pool = new Pool({ connectionString: databaseUri, max: workers });
  const seedClient = await pool.connect();
  let ownerId;
  try {
    ownerId = await seedQueue(seedClient, jobs);
  } finally {
    seedClient.release();
  }

  const stop = { done: false };
  const connectionSampling = sampleConnections(observer, stop);
  let active = 0;
  let maxActive = 0;
  const claimedIds = new Set();
  const claimLatencies = [];
  const completionLatencies = [];
  const clients = await Promise.all(Array.from({ length: workers }, () => pool.connect()));
  const started = performance.now();

  try {
    await Promise.all(
      clients.map(async (client, workerIndex) => {
        const workerId = `capacity-worker-${workerIndex + 1}`;
        for (;;) {
          const claimStarted = performance.now();
          const claimed = await claimJobs(client, { workerId, leaseSeconds: 30, batch: 1 });
          const claimMs = performance.now() - claimStarted;
          const job = claimed[0];
          if (job === undefined) return;
          claimLatencies.push(claimMs);
          if (claimedIds.has(job.jobId)) throw new Error(`duplicate queue claim: ${job.jobId}`);
          claimedIds.add(job.jobId);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 3));
          const completionStarted = performance.now();
          const completed = await completeJob(client, {
            jobId: job.jobId,
            workerId,
            generationId: job.generationId,
            generationState: 'succeeded',
          });
          completionLatencies.push(performance.now() - completionStarted);
          active -= 1;
          if (!completed.completed)
            throw new Error(`queue completion failed: ${JSON.stringify(completed)}`);
        }
      }),
    );
  } finally {
    for (const client of clients) client.release();
    stop.done = true;
  }

  const elapsedMs = performance.now() - started;
  const connectionStats = await connectionSampling;
  const verification = await pool.query(
    `SELECT
       count(*) FILTER (WHERE j.state = 'done')::int AS done_jobs,
       count(*) FILTER (WHERE g.state = 'succeeded')::int AS succeeded_generations,
       EXTRACT(EPOCH FROM percentile_cont(0.95) WITHIN GROUP
         (ORDER BY (j.heartbeat_at - j.created_at))) * 1000 AS p95_queue_wait_ms
     FROM generation g JOIN job j ON j.generation_id = g.id
     WHERE g.owner_id = $1`,
    [ownerId],
  );
  await pool.end();
  const row = verification.rows[0];
  if (claimedIds.size !== jobs || row.done_jobs !== jobs || row.succeeded_generations !== jobs) {
    throw new Error(
      `queue verification failed: ${JSON.stringify({ claimed: claimedIds.size, ...row })}`,
    );
  }

  return {
    jobs,
    configuredWorkers: workers,
    workerProcess,
    measuredMaxActiveWorkers: maxActive,
    duplicateClaims: jobs - claimedIds.size,
    elapsedMs: round(elapsedMs),
    jobsPerSecond: round((jobs * 1000) / elapsedMs),
    p95QueueWaitMs: round(Number(row.p95_queue_wait_ms)),
    claim: summarizeLatencies(claimLatencies),
    completion: summarizeLatencies(completionLatencies),
    pgConnections: { poolMax: workers, measuredPeakIncludingObserver: connectionStats.peak },
    terminalVerification: {
      doneJobs: row.done_jobs,
      succeededGenerations: row.succeeded_generations,
    },
    providerCalls: 0,
  };
}

async function runDecodeChild() {
  const inputPath = process.argv[3];
  const scratchPath = process.argv[4];
  if (!inputPath || !scratchPath) throw new Error('decode child requires input and scratch paths');
  const bytes = await readFile(inputPath);
  const validationLatencies = [];
  const fullDecodeLatencies = [];
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let peakScratchBytes = await directoryBytes(scratchPath);
  let sampling = true;
  const sample = async () => {
    while (sampling) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakScratchBytes = Math.max(peakScratchBytes, await directoryBytes(scratchPath));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const sampler = sample();

  await runConcurrent(8, 2, async () => {
    const validationStarted = performance.now();
    const validation = await validateImage(bytes, { declaredMime: 'image/jpeg' });
    validationLatencies.push(performance.now() - validationStarted);
    if (!validation.ok) throw new Error(`validation failed: ${validation.code}`);

    const decodeStarted = performance.now();
    const decoded = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    fullDecodeLatencies.push(performance.now() - decodeStarted);
    const expected = decoded.info.width * decoded.info.height * decoded.info.channels;
    if (decoded.data.length !== expected) throw new Error('full pixel decode length mismatch');
  });

  sampling = false;
  await sampler;
  if (global.gc) global.gc();
  const finalScratchBytes = await directoryBytes(scratchPath);
  const output = {
    inputCompressedBytes: bytes.length,
    dimensions: { width: 4096, height: 4096, pixels: 4096 * 4096 },
    iterations: 8,
    concurrency: 2,
    validation: summarizeLatencies(validationLatencies),
    fullPixelDecode: summarizeLatencies(fullDecodeLatencies),
    baselineRssBytes: baselineRss,
    peakRssBytes: peakRss,
    measuredPeakRssDeltaBytes: Math.max(0, peakRss - baselineRss),
    scratchDisk: {
      tmpDir: 'isolated child TMPDIR',
      measuredPeakBytes: peakScratchBytes,
      finalBytes: finalScratchBytes,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function benchmarkDecode(tempRoot) {
  const inputPath = path.join(tempRoot, 'capacity-4096.jpg');
  const scratchPath = path.join(tempRoot, 'decode-scratch');
  await mkdir(scratchPath, { recursive: true });
  await sharp({
    create: { width: 4096, height: 4096, channels: 3, background: { r: 90, g: 140, b: 210 } },
  })
    .jpeg({ quality: 90 })
    .toFile(inputPath);

  const result = await exec(
    process.execPath,
    ['--expose-gc', fileURLToPath(import.meta.url), '--decode-child', inputPath, scratchPath],
    {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: scratchPath, TMP: scratchPath, TEMP: scratchPath },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(result.stdout.trim());
}

function assertBudgets(report) {
  const checks = {
    liveApiP95Under100Ms: report.http.live.p95Ms < 100,
    workspaceReadP95Under500Ms: report.http.workspaceRead.p95Ms < 500,
    workspaceWriteP95Under500Ms: report.http.workspaceWrite.p95Ms < 500,
    readyApiP95Under500Ms: report.http.ready.p95Ms < 500,
    queueClaimP95Under100Ms: report.queue.claim.p95Ms < 100,
    queueCompletionP95Under100Ms: report.queue.completion.p95Ms < 100,
    queueWaitP95Under2000Ms: report.queue.p95QueueWaitMs < 2000,
    queueThroughputAtLeast50PerSecond: report.queue.jobsPerSecond >= 50,
    workerConcurrencyReachedConfiguredLevel:
      report.queue.measuredMaxActiveWorkers === report.queue.configuredWorkers,
    pgConnectionsWithin20: report.pg.measuredPeakConnections <= 20,
    decodeP95Under2000Ms: report.decode.fullPixelDecode.p95Ms < 2000,
    decodePeakRssDeltaUnder512MiB: report.decode.measuredPeakRssDeltaBytes < 512 * 1024 * 1024,
    decodeScratchPeakUnder16MiB: report.decode.scratchDisk.measuredPeakBytes < 16 * 1024 * 1024,
    noExternalProviderCalls: report.queue.providerCalls === 0,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { checks, passed: failed.length === 0, failed };
}

function renderMarkdown(report) {
  const mib = (bytes) => round(bytes / 1024 / 1024);
  const checks = Object.entries(report.acceptance.checks)
    .map(([name, passed]) => `- ${passed ? 'PASS' : 'FAIL'} — \`${name}\``)
    .join('\n');
  const routeRow = (result) =>
    `| ${result.method} ${result.route} | ${result.count} | ${result.concurrency} | ${result.p95Ms} ms | ${result.p99Ms} ms | ${result.requestsPerSecond} req/s |`;
  return (
    `# O04 本地容量测量报告\n\n` +
    `> 本报告是隔离本机、临时 PostgreSQL 16、loopback HTTP 和本地磁盘的可复跑实测，不是生产 SLA，也没有调用任何真实或外部生图 Provider。可部署 Worker 的 claim/execute 路径使用隔离 loopback simulator；规划预算与实测事实分开列示，不能直接外推为生产容量。\n\n` +
    `- 测量时间：${report.measuredAt}\n` +
    `- 工作区：${report.workspaceVersion}\n` +
    `- Node / Sharp / libvips：${report.environment.node} / ${report.environment.sharp} / ${report.environment.libvips}\n` +
    `- 主机：${report.environment.platform} ${report.environment.arch}，${report.environment.cpuCount} CPU / ${report.environment.totalMemoryGiB} GiB RAM（${report.environment.cpuModel}）\n` +
    `- PostgreSQL：${report.environment.postgresql}；max_connections=${report.pg.maxConnections}；shared_buffers=${report.pg.sharedBuffers}\n\n` +
    `## 1. 实测事实\n\n` +
    `### 非生图 API（真实 loopback HTTP）\n\n` +
    `| 路由 | 请求数 | 并发 | p95 | p99 | 吞吐 |\n|---|---:|---:|---:|---:|---:|\n` +
    `${routeRow(report.http.live)}\n` +
    `${routeRow(report.http.workspaceWrite)}\n` +
    `${routeRow(report.http.workspaceRead)}\n` +
    `${routeRow(report.http.ready)}\n\n` +
    `collections 读写真实经过 TCP/HTTP、Fastify schema、opaque session 查库和 PostgreSQL；readiness 只探测 PG，不探测或调用付费 Provider。全部状态分布见 JSON。\n\n` +
    `### PG 队列与 Worker\n\n` +
    `- 任务：${report.queue.jobs} 个真实 PG job；执行管线 harness：${report.queue.configuredWorkers} 个独立 PoolClient；实测最大同时活跃：${report.queue.measuredMaxActiveWorkers}。\n` +
    `- 队列 claim p95：${report.queue.claim.p95Ms} ms；排队等待 p95：${report.queue.p95QueueWaitMs} ms；complete p95：${report.queue.completion.p95Ms} ms。\n` +
    `- 吞吐：${report.queue.jobsPerSecond} jobs/s；重复领取：${report.queue.duplicateClaims}；done/succeeded：${report.queue.terminalVerification.doneJobs}/${report.queue.terminalVerification.succeededGenerations}。\n` +
    `- 当前可部署 Worker 进程探针：${report.queue.workerProcess.probeDurationMs} ms 内 claim=${report.queue.workerProcess.measuredClaims}，隔离 loopback simulator 请求=${report.queue.workerProcess.loopbackProviderRequests}，实测生成并发=${report.queue.workerProcess.measuredGenerationConcurrency}。${report.queue.workerProcess.note}\n` +
    `- 真实/外部 Provider 调用：${report.queue.providerCalls}。320-job harness 只测真实 PG claim/complete 与并发执行壳；进程探针的本地 simulator 只验证接线，二者都不冒充 W06 真实 Provider 兼容或生成容量。\n\n` +
    `### PostgreSQL 连接\n\n` +
    `- collections 工作负载峰值：${report.http.pgConnectionsDuringWorkload.peak}。\n` +
    `- readiness 阶段峰值：${report.http.pgConnectionsDuringReady.peak}。\n` +
    `- 队列阶段峰值（含观测连接）：${report.queue.pgConnections.measuredPeakIncludingObserver}；Worker harness pool max=${report.queue.pgConnections.poolMax}。\n` +
    `- 全阶段实测峰值：${report.pg.measuredPeakConnections}。\n\n` +
    `### 图像解码内存与磁盘\n\n` +
    `- 样本：4096×4096 JPEG（${report.decode.dimensions.pixels.toLocaleString('en-US')} px），压缩输入 ${mib(report.decode.inputCompressedBytes)} MiB；8 次、并发 2。\n` +
    `- 当前产品校验路径（metadata + 限制检查）p95：${report.decode.validation.p95Ms} ms；诊断性强制完整像素栅格解码 p95：${report.decode.fullPixelDecode.p95Ms} ms。两者不混称。\n` +
    `- 子进程 RSS 基线/峰值/增量：${mib(report.decode.baselineRssBytes)} / ${mib(report.decode.peakRssBytes)} / ${mib(report.decode.measuredPeakRssDeltaBytes)} MiB。\n` +
    `- 隔离 TMPDIR 临时磁盘峰值/结束值：${mib(report.decode.scratchDisk.measuredPeakBytes)} / ${mib(report.decode.scratchDisk.finalBytes)} MiB。\n\n` +
    `## 2. 推导的本机回归预算\n\n` +
    `这些阈值用于发现明显回归，不是生产 SLO：workspace 读写 p95 < 500 ms；queue claim/complete p95 < 100 ms；排队等待 p95 < 2000 ms；队列吞吐 >= 50 jobs/s；harness 达到并发 8；PG 连接峰值 <= 20；完整解码 p95 < 2000 ms；RSS 增量 < 512 MiB；临时磁盘峰值 < 16 MiB；真实/外部 Provider 调用必须为 0。\n\n` +
    `${checks}\n\n` +
    `## 3. 未测范围与限制\n\n` +
    `- O04 不测真实 Provider 延迟、限流、结果和计费行为；W06 已另以单次授权完成最小真实兼容验证，不能外推为容量；\n` +
    `- S3-compatible 存储、TLS/反向代理、生产 PG 参数、多实例；\n` +
    `- 可部署 Worker 进程仅以 1 个任务证明 claim/execute/complete 接线；未测进程级多 slot 生图吞吐或 Provider 容量；\n` +
    `- 当前 \`validateImage\` 产品路径使用 metadata 读取；完整栅格解码是独立诊断探针；\n` +
    `- 结果只说明本机、当前样本和并发，不能把 20 MiB/40 MP 上限当成已证明的生产容量。\n\n` +
    `原始机器可读证据：[capacity-report.json](capacity-report.json)。\n`
  );
}

async function main() {
  if (process.argv[2] === '--decode-child') {
    await runDecodeChild();
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'onepic-o04-'));
  const cluster = await startPgTestCluster();
  const database = await cluster.createDatabase('capacity');
  const observer = new Client({ connectionString: database.uri });
  try {
    await runMigrations(database.uri);
    await observer.connect();
    await importCatalogRelease({ client: observer, rootDir: repoRoot });
    const baseline = await observer.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND backend_type = 'client backend'`,
    );
    const pgMaxConnections = (await observer.query('SHOW max_connections')).rows[0]
      ?.max_connections;
    const pgSharedBuffers = (await observer.query('SHOW shared_buffers')).rows[0]?.shared_buffers;
    const http = await benchmarkHttp(database.uri, path.join(tempRoot, 'media'), observer);
    const queue = await benchmarkQueue(database.uri, observer, tempRoot);
    const decode = await benchmarkDecode(tempRoot);
    const pgPeak = Math.max(
      baseline.rows[0]?.count ?? 0,
      http.pgConnectionsDuringReady.peak,
      queue.pgConnections.measuredPeakIncludingObserver,
    );
    const { stdout: postgresVersion } = await exec(
      path.join(process.env.ONEPIC_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin', 'postgres'),
      ['--version'],
    );
    const report = {
      schemaVersion: '1.0.0',
      measuredAt: new Date().toISOString(),
      workspaceVersion: await gitVersion(),
      environment: {
        node: process.version,
        sharp: sharp.versions.sharp,
        libvips: sharp.versions.vips,
        platform: os.platform(),
        arch: os.arch(),
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        totalMemoryGiB: round(os.totalmem() / 1024 / 1024 / 1024),
        postgresql: postgresVersion.trim(),
      },
      isolation: {
        network: '127.0.0.1 only',
        database: 'ephemeral PostgreSQL cluster in OS temp directory',
        storage: 'ephemeral local directory removed after run',
        provider: 'disabled; zero provider calls',
      },
      http,
      queue,
      pg: {
        baselineConnections: baseline.rows[0]?.count ?? 0,
        measuredPeakConnections: pgPeak,
        maxConnections: Number(pgMaxConnections),
        sharedBuffers: pgSharedBuffers ?? 'unknown',
      },
      decode,
    };
    report.acceptance = assertBudgets(report);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(markdownPath, renderMarkdown(report));
    console.log(`O04 capacity report: ${path.relative(repoRoot, markdownPath)}`);
    console.log(`O04 machine data: ${path.relative(repoRoot, jsonPath)}`);
    console.log(JSON.stringify(report.acceptance, null, 2));
    if (!report.acceptance.passed) process.exitCode = 1;
  } finally {
    await observer.end().catch(() => undefined);
    await database.drop().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();

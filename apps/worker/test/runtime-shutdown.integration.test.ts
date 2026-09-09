import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { LocalDiskStorage, validateImage } from '@onepic/managed-runtime';
import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';
import { Client, Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../api/src/db/migrate.js';
import { GenerationWorkerRuntime } from '../src/runtime.js';

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let setupClient: Client;
let storageRoot: string;
let storage: LocalDiskStorage;
let inputPng: Buffer;
let resultPng: Buffer;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('worker_runtime');
  await runMigrations(database.uri);
  setupClient = new Client({ connectionString: database.uri });
  await setupClient.connect();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'onepic-worker-runtime-'));
  storage = new LocalDiskStorage(storageRoot);
  inputPng = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  resultPng = await sharp({
    create: { width: 3, height: 2, channels: 3, background: '#654321' },
  })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await setupClient?.end();
  await database?.drop();
  await cluster?.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

async function seedGeneration(): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '');
  const prompt = '[System / Prompt]\nO05 runtime\nBEGIN VISUAL BLUEPRINT\nx\nEND VISUAL BLUEPRINT';
  const promptSha = createHash('sha256').update(prompt).digest('hex');
  const inputSha = createHash('sha256').update(inputPng).digest('hex');
  const subject = await setupClient.query<{ id: string }>(
    `INSERT INTO subject (issuer, subject_claim, role)
     VALUES ('https://runtime.test', $1, 'member') RETURNING id`,
    [`runtime-${suffix}`],
  );
  const ownerId = subject.rows[0]!.id;
  const release = await setupClient.query<{ id: string }>(
    `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
     VALUES ('1.0.0', $1, $2, 1) RETURNING id`,
    [`source-${suffix}`, `library-${suffix}`],
  );
  const releaseId = release.rows[0]!.id;
  const version = await setupClient.query<{ id: string }>(
    `INSERT INTO template_version
       (catalog_release_id, template_key, version, compiled_prompt_sha256,
        blueprint_sha256, metadata, prompt_text)
     VALUES ($1, $2, 1, $3, $4, '{}', $5) RETURNING id`,
    [releaseId, `case-${suffix}`, promptSha, `blueprint-${suffix}`, `${prompt}\n`],
  );
  const objectKey = `inputs/${suffix}.png`;
  await storage.put({ bucket: 'quarantine', key: objectKey, body: inputPng });
  const media = await setupClient.query<{ id: string }>(
    `INSERT INTO media_object
       (owner_id, kind, state, bucket, object_key, mime, bytes, width, height, sha256, expires_at)
     VALUES ($1, 'input', 'ready', 'quarantine', $2, 'image/png', $3, 2, 2, $4,
       now() + interval '1 day') RETURNING id`,
    [ownerId, objectKey, inputPng.length, inputSha],
  );
  const precheck = await setupClient.query<{ id: string }>(
    `INSERT INTO precheck
       (subject_id, media_object_id, template_version_id, settings, result, expires_at)
     VALUES ($1, $2, $3, '{"quality":"high"}', 'passed', now() + interval '1 hour')
     RETURNING id`,
    [ownerId, media.rows[0]!.id, version.rows[0]!.id],
  );
  const generation = await setupClient.query<{ id: string }>(
    `INSERT INTO generation
       (owner_id, template_version_id, catalog_release_id, precheck_id, input_object_id,
        input_sha256, compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
        settings, idempotency_key, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'managed-primary', 'gpt-image-2',
       '{"quality":"high"}', $8, 'queued') RETURNING id`,
    [
      ownerId,
      version.rows[0]!.id,
      releaseId,
      precheck.rows[0]!.id,
      media.rows[0]!.id,
      inputSha,
      promptSha,
      `runtime-${suffix}`,
    ],
  );
  await setupClient.query(
    `INSERT INTO job (generation_id, kind, state, run_after)
     VALUES ($1, 'generate', 'pending', now())`,
    [generation.rows[0]!.id],
  );
  return generation.rows[0]!.id;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('deployable generation worker graceful shutdown (O05)', () => {
  it('parks an in-flight provider request as outcome_unknown and never reclaims it', async () => {
    const generationId = await seedGeneration();
    const pool = new Pool({ connectionString: database.uri, max: 4 });
    let calls = 0;
    let started = false;
    const blockingAdapter = {
      async generate(request: { signal?: AbortSignal }) {
        calls += 1;
        started = true;
        return await new Promise<{
          ok: false;
          code: 'PROVIDER_TIMEOUT_UNKNOWN';
          message: string;
        }>((resolve) => {
          const finish = () =>
            resolve({
              ok: false,
              code: 'PROVIDER_TIMEOUT_UNKNOWN',
              message: 'aborted by graceful shutdown',
            });
          if (request.signal?.aborted === true) finish();
          else request.signal?.addEventListener('abort', finish, { once: true });
        });
      },
    };
    const runtime = new GenerationWorkerRuntime({
      pool,
      execution: {
        adapter: blockingAdapter,
        storage,
        validateImage,
        providerId: 'managed-primary',
      },
      concurrency: 1,
      pollIntervalMs: 10,
      leaseSeconds: 10,
      heartbeatSeconds: 2,
      shutdownGraceMs: 40,
      workerIdPrefix: 'shutdown-test',
    });
    runtime.start();
    await waitFor(() => started);

    const report = await runtime.stop();
    expect(report).toMatchObject({
      graceful: false,
      activeAtSignal: 1,
      markedOutcomeUnknown: 1,
      aborted: 1,
      remaining: 0,
    });
    expect(calls).toBe(1);

    const row = await setupClient.query<{
      generation_state: string;
      job_state: string;
      dead_reason: string | null;
      attempt_state: string;
    }>(
      `SELECT g.state AS generation_state, j.state AS job_state, j.dead_reason,
              (SELECT state FROM attempt WHERE generation_id = g.id ORDER BY attempt_no DESC LIMIT 1)
                AS attempt_state
       FROM generation g JOIN job j ON j.generation_id = g.id WHERE g.id = $1`,
      [generationId],
    );
    expect(row.rows[0]).toMatchObject({
      generation_state: 'outcome_unknown',
      job_state: 'dead',
      dead_reason: 'WORKER_SHUTDOWN_OUTCOME_UNKNOWN',
      attempt_state: 'unknown',
    });

    let restartCalls = 0;
    const restarted = new GenerationWorkerRuntime({
      pool,
      execution: {
        adapter: {
          async generate() {
            restartCalls += 1;
            return { ok: true as const, value: { imageBytes: resultPng, rawBody: resultPng } };
          },
        },
        storage,
        validateImage,
        providerId: 'managed-primary',
      },
      concurrency: 1,
      pollIntervalMs: 10,
      leaseSeconds: 10,
      heartbeatSeconds: 2,
      shutdownGraceMs: 200,
      workerIdPrefix: 'restart-test',
    });
    restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await restarted.stop();
    expect(restartCalls).toBe(0);
    await pool.end();
  });

  it('waits for work that completes inside the grace window', async () => {
    const generationId = await seedGeneration();
    const pool = new Pool({ connectionString: database.uri, max: 4 });
    let started = false;
    const runtime = new GenerationWorkerRuntime({
      pool,
      execution: {
        adapter: {
          async generate() {
            started = true;
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { ok: true as const, value: { imageBytes: resultPng, rawBody: resultPng } };
          },
        },
        storage,
        validateImage,
        providerId: 'managed-primary',
      },
      concurrency: 1,
      pollIntervalMs: 10,
      leaseSeconds: 10,
      heartbeatSeconds: 2,
      shutdownGraceMs: 1000,
      workerIdPrefix: 'grace-test',
    });
    runtime.start();
    await waitFor(() => started);
    const report = await runtime.stop();
    expect(report).toMatchObject({ graceful: true, activeAtSignal: 1, remaining: 0 });

    const row = await setupClient.query<{ generation_state: string; job_state: string }>(
      `SELECT g.state AS generation_state, j.state AS job_state
       FROM generation g JOIN job j ON j.generation_id = g.id WHERE g.id = $1`,
      [generationId],
    );
    expect(row.rows[0]).toEqual({ generation_state: 'succeeded', job_state: 'done' });
    await pool.end();
  });
});

/**
 * OnePic Worker process (O05): retention, internal health/metrics and the
 * deployable PostgreSQL generation consumer.
 *
 * Managed generation is opt-in (`WORKER_GENERATION_ENABLED=true`) and refuses
 * startup unless the database and exact allowlisted provider configuration are
 * present. Provider credentials are never logged. SIGTERM/SIGINT stops new
 * claims, waits for the configured grace period and parks any still in-flight
 * provider side effect in outcome_unknown before aborting, so restart cannot
 * blindly re-send a possibly billed request.
 */

import http from 'node:http';

import { LocalDiskStorage, ProviderAdapter, validateImage } from '@onepic/managed-runtime';
import { Pool } from 'pg';

import { CleanupService, type RetentionPolicy } from './cleanup.js';
import { loadWorkerConfig, WorkerConfigError } from './config.js';
import { logEvent } from './logging.js';
import {
  COUNTER_PURGE_FAILURES,
  COUNTER_STORAGE_FAILURES,
  COUNTER_SWEEP_FAILURES,
  createMetricsHandler,
  createMetricsRegistry,
  type MetricsRegistry,
} from './metrics.js';
import { GenerationWorkerRuntime } from './runtime.js';

class CountingStorage extends LocalDiskStorage {
  constructor(
    rootDir: string,
    private readonly registry: MetricsRegistry,
  ) {
    super(rootDir);
  }

  override async remove(input: { bucket: string; key: string }): Promise<void> {
    try {
      await super.remove(input);
    } catch (error) {
      this.registry.increment(COUNTER_STORAGE_FAILURES);
      throw error;
    }
  }
}

let config;
try {
  config = loadWorkerConfig(process.env);
} catch (error) {
  if (error instanceof WorkerConfigError) {
    logEvent('worker_config_invalid', { issues: error.issues });
    process.exit(1);
  }
  throw error;
}

let acceptingSignals = true;
let cleanupTimer: NodeJS.Timeout | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let pool: Pool | undefined;
let metricsServer: http.Server | undefined;
let generationRuntime: GenerationWorkerRuntime | undefined;

async function closeHttpServer(server: http.Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (!acceptingSignals) return;
  acceptingSignals = false;
  if (cleanupTimer !== undefined) clearInterval(cleanupTimer);
  if (idleTimer !== undefined) clearInterval(idleTimer);
  const runtimeReport = await generationRuntime?.stop();
  await closeHttpServer(metricsServer).catch(() => undefined);
  if ((runtimeReport?.remaining ?? 0) === 0) {
    await pool?.end().catch(() => undefined);
  }
  logEvent('worker_stopped', {
    signal,
    ...(runtimeReport === undefined ? {} : { generation: runtimeReport }),
  });
  process.exit(0);
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));

if (config.databaseUrl === undefined) {
  logEvent('worker_started', { cleanup: false, generation: false, metrics: false });
  idleTimer = setInterval(() => {}, 2 ** 30);
} else {
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: Math.max(4, config.generation.concurrency + 2),
    application_name: 'onepic-worker',
  });
  try {
    await pool.query('SELECT 1');
  } catch {
    logEvent('worker_database_unavailable');
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  const registry = createMetricsRegistry();
  registry.increment(COUNTER_SWEEP_FAILURES, 0);
  registry.increment(COUNTER_PURGE_FAILURES, 0);
  registry.increment(COUNTER_STORAGE_FAILURES, 0);

  const storage = new CountingStorage(config.mediaStorageRoot, registry);
  const policy: RetentionPolicy = config.retention;
  const cleanup = new CleanupService(pool, storage, policy);
  const runSweep = async (): Promise<void> => {
    try {
      const report = await cleanup.sweep();
      if (report.failures.length > 0) {
        registry.increment(COUNTER_PURGE_FAILURES, report.failures.length);
      }
      logEvent('retention_sweep', { ...report, failures: report.failures.length });
    } catch (error) {
      registry.increment(COUNTER_SWEEP_FAILURES);
      logEvent('retention_sweep_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  void runSweep();
  cleanupTimer = setInterval(() => void runSweep(), config.cleanupIntervalSeconds * 1000);
  cleanupTimer.unref?.();

  if (config.generationEnabled) {
    const provider = config.provider;
    if (provider === undefined) {
      logEvent('worker_config_invalid', {
        issues: [{ field: 'WORKER_PROVIDER_*', problem: 'provider configuration is incomplete' }],
      });
      await pool.end();
      process.exit(1);
    }
    generationRuntime = new GenerationWorkerRuntime({
      pool,
      execution: {
        adapter: new ProviderAdapter(provider),
        storage,
        validateImage,
        providerId: provider.providerId,
      },
      ...config.generation,
      log: logEvent,
    });
    generationRuntime.start();
  }

  if (config.metricsPort !== undefined) {
    const handler = createMetricsHandler({
      db: pool,
      registry,
      isReady: () =>
        acceptingSignals &&
        (!config.generationEnabled || generationRuntime?.snapshot().started === true),
    });
    metricsServer = http.createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      metricsServer!.once('error', reject);
      metricsServer!.listen(config.metricsPort, config.metricsHost, resolve);
    });
  }

  logEvent('worker_started', {
    cleanup: true,
    cleanupIntervalSeconds: config.cleanupIntervalSeconds,
    generation: config.generationEnabled,
    ...(config.generationEnabled ? { concurrency: config.generation.concurrency } : {}),
    metrics:
      config.metricsPort === undefined ? false : `${config.metricsHost}:${config.metricsPort}`,
  });
}

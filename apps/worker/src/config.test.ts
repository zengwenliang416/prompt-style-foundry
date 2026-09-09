import { describe, expect, it } from 'vitest';

import { loadWorkerConfig, WorkerConfigError } from './config.js';

const managedEnv = {
  DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/onepic',
  WORKER_GENERATION_ENABLED: 'true',
  WORKER_PROVIDER_ID: 'managed-primary',
  WORKER_PROVIDER_BASE_URL: 'https://images.example.com',
  WORKER_PROVIDER_API_KEY: 'sentinel-provider-secret',
  WORKER_PROVIDER_MODELS: 'gpt-image-2:high+medium,other.model:standard',
};

describe('worker config', () => {
  it('loads an explicit managed generation configuration', () => {
    const config = loadWorkerConfig({
      ...managedEnv,
      WORKER_CONCURRENCY: '4',
      WORKER_POLL_INTERVAL_MS: '250',
      WORKER_LEASE_SECONDS: '90',
      WORKER_HEARTBEAT_SECONDS: '20',
      WORKER_SHUTDOWN_GRACE_SECONDS: '45',
      METRICS_PORT: '9090',
    });

    expect(config.generationEnabled).toBe(true);
    expect(config.generation).toEqual({
      concurrency: 4,
      pollIntervalMs: 250,
      leaseSeconds: 90,
      heartbeatSeconds: 20,
      shutdownGraceMs: 45_000,
    });
    expect(config.provider?.models).toEqual([
      { id: 'gpt-image-2', qualities: ['high', 'medium'] },
      { id: 'other.model', qualities: ['standard'] },
    ]);
    expect(config.metricsPort).toBe(9090);
  });

  it('keeps cleanup-only mode usable without provider credentials', () => {
    const config = loadWorkerConfig({ DATABASE_URL: managedEnv.DATABASE_URL });
    expect(config.generationEnabled).toBe(false);
    expect(config.provider).toBeUndefined();
  });

  it('refuses managed generation when credentials are missing without leaking values', () => {
    const sentinel = 'sentinel-provider-secret';
    let caught: unknown;
    try {
      loadWorkerConfig({ WORKER_GENERATION_ENABLED: 'true', WORKER_PROVIDER_API_KEY: sentinel });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkerConfigError);
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain(sentinel);
    expect((caught as WorkerConfigError).issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'WORKER_PROVIDER_ID',
        'WORKER_PROVIDER_BASE_URL',
        'WORKER_PROVIDER_MODELS',
      ]),
    );
  });

  it('rejects non-loopback HTTP provider origins and malformed timing', () => {
    expect(() =>
      loadWorkerConfig({
        ...managedEnv,
        WORKER_PROVIDER_BASE_URL: 'http://169.254.169.254',
        WORKER_HEARTBEAT_SECONDS: '60',
        WORKER_LEASE_SECONDS: '60',
      }),
    ).toThrow(WorkerConfigError);
  });

  it('allows loopback HTTP only for isolated test providers', () => {
    const config = loadWorkerConfig({
      ...managedEnv,
      WORKER_PROVIDER_BASE_URL: 'http://127.0.0.1:4567',
    });
    expect(config.provider?.baseUrl).toBe('http://127.0.0.1:4567');
  });
});

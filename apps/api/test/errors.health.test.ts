// @vitest-environment happy-dom
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { AppError, registerErrorHandling } from '../src/bootstrap/errors.js';
import { openApiSchema } from '../src/bootstrap/schema.js';
import type { ApiConfig } from '../src/config/env.js';

const config: ApiConfig = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'fatal',
  runMode: 'catalog-only',
};

const apps: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
});

async function buildWithErrorRoutes(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerErrorHandling(app, config);
  app.post(
    '/probe/validation',
    { schema: { body: openApiSchema('HealthReady') } },
    async () => ({ ok: true }),
  );
  app.get('/probe/app-error', async () => {
    throw new AppError(429, 'RATE_LIMITED', 'slow down');
  });
  app.get('/probe/unexpected', async () => {
    throw new Error('secret stack detail: password=hunter2');
  });
  app.get('/probe/echo-correlation', async (request, reply) => {
    void reply.header('x-correlation-id', request.id);
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe('unified error envelope + correlation IDs (B06)', () => {
  it('renders validation failures as VALIDATION_FAILED envelopes', async () => {
    const app = await buildWithErrorRoutes();
    const response = await app.inject({
      method: 'POST',
      url: '/probe/validation',
      payload: { status: 'not-a-status' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.correlationId).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('renders AppError with its stable code and status', async () => {
    const app = await buildWithErrorRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe/app-error' });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', message: 'slow down' },
    });
    expect(response.headers['x-correlation-id']).toBeDefined();
  });

  it('hides unexpected error internals behind INTERNAL', async () => {
    const app = await buildWithErrorRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe/unexpected' });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('secret stack');
  });

  it('echoes an incoming x-correlation-id and generates one otherwise', async () => {
    const app = await buildWithErrorRoutes();
    const echoed = await app.inject({
      method: 'GET',
      url: '/probe/echo-correlation',
      headers: { 'x-correlation-id': 'my-trace-42' },
    });
    expect(echoed.headers['x-correlation-id']).toBe('my-trace-42');

    const generated = await app.inject({ method: 'GET', url: '/probe/echo-correlation' });
    expect(generated.headers['x-correlation-id']).toBeDefined();
    expect(generated.headers['x-correlation-id']).not.toBe('my-trace-42');
  });

  it('gives the 404 an envelope with a stable code', async () => {
    const app = await buildWithErrorRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('health endpoints (B06)', () => {
  it('live stays ok and ready reports degraded when PG is unreachable', async () => {
    const { Pool } = await import('pg');
    const badConfig: ApiConfig = { ...config, databaseUrl: 'postgresql://postgres@127.0.0.1:1/none' };
    const app = Fastify({ logger: false });
    apps.push(app);
    const { registerHealthRoutes } = await import('../src/bootstrap/health.js');
    const { registerErrorHandling: register } = await import('../src/bootstrap/errors.js');
    register(app as never, badConfig);
    registerHealthRoutes(app as never, badConfig);
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => {
      throw new Error('connection refused');
    });
    await app.ready();

    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ data: { status: 'ok' } });

    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ data: { status: 'degraded' } });
  });
});

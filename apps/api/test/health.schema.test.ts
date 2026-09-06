import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import type { ApiConfig } from '../src/config/env.js';
import { buildApp } from '../src/bootstrap/app.js';
import { openApiSchema } from '../src/bootstrap/schema.js';

const schemas = {
  ApiSuccessOfHealthLive: openApiSchema('ApiSuccessOfHealthLive'),
  ApiErrorBody: openApiSchema('ApiErrorBody'),
  HealthReady: openApiSchema('HealthReady'),
};

const testApiConfig: ApiConfig = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'fatal',
  runMode: 'catalog-only',
};

const scratchApps: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const app of scratchApps) {
    await app.close();
  }
});

async function buildScratchApp(): Promise<ReturnType<typeof Fastify>> {
  // Mirror buildApp's fail-loud ajv settings so the probe reflects production.
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  scratchApps.push(app);
  return app;
}

describe('OpenAPI-driven runtime validation (F05)', () => {
  it('serializes /health/live exactly to the contract envelope', async () => {
    const app = buildApp(testApiConfig);
    scratchApps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ data: { status: 'ok' } });
  });

  it('serializes /health/ready exactly to the contract envelope', async () => {
    const app = buildApp(testApiConfig);
    scratchApps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'ok' } });
  });

  it('strips undeclared fields from responses (additionalProperties: false)', async () => {
    const app = await buildScratchApp();
    app.post(
      '/schema-probe',
      { schema: { response: { 200: schemas['ApiSuccessOfHealthLive'] } } },
      async () =>
        ({
          data: { status: 'ok', injected: 'must-not-leak' },
          meta: { requestId: 'r1' },
          smuggled: 'must-not-leak',
        }) as never,
    );

    const response = await app.inject({ method: 'POST', url: '/schema-probe' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'ok' }, meta: { requestId: 'r1' } });
  });

  it('rejects request bodies with unknown fields (additionalProperties: false)', async () => {
    const app = await buildScratchApp();
    app.post(
      '/schema-probe',
      { schema: { body: schemas['ApiErrorBody'] } },
      async () => ({ ok: true }) as never,
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/schema-probe',
      payload: {
        code: 'boom',
        message: 'm',
        correlationId: 'c1',
        unexpectedField: 'rejected',
      },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'POST',
      url: '/schema-probe',
      payload: { code: 'boom', message: 'm', correlationId: 'c1' },
    });
    expect(valid.statusCode).toBe(200);
  });

  it('rejects request bodies violating enum constraints', async () => {
    const app = await buildScratchApp();
    app.post(
      '/schema-probe',
      { schema: { body: schemas['HealthReady'] } },
      async () => ({ ok: true }) as never,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/schema-probe',
      payload: { status: 'not-a-status' },
    });
    expect(response.statusCode).toBe(400);
  });
});

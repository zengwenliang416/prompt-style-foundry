import { describe, expect, it } from 'vitest';

import { createMetricsHandler, createMetricsRegistry } from './metrics.js';

function responseRecorder() {
  let status = 0;
  let body = '';
  return {
    response: {
      writeHead(nextStatus: number): void {
        status = nextStatus;
      },
      end(nextBody = ''): void {
        body = nextBody;
      },
    },
    result: () => ({ status, body: JSON.parse(body) as unknown }),
  };
}

describe('worker internal health endpoints', () => {
  it('serves liveness without touching PostgreSQL', async () => {
    let queries = 0;
    const handler = createMetricsHandler({
      db: {
        async query() {
          queries += 1;
          return { rows: [], rowCount: 0 };
        },
      },
      registry: createMetricsRegistry(),
    });
    const recorder = responseRecorder();
    await handler({ url: '/internal/health/live' }, recorder.response);
    expect(recorder.result()).toEqual({ status: 200, body: { data: { status: 'ok' } } });
    expect(queries).toBe(0);
  });

  it('reports readiness and stopping state after a real DB probe abstraction', async () => {
    let ready = true;
    const handler = createMetricsHandler({
      db: {
        async query() {
          return { rows: [], rowCount: 1 };
        },
      },
      registry: createMetricsRegistry(),
      isReady: () => ready,
    });
    const first = responseRecorder();
    await handler({ url: '/internal/health/ready' }, first.response);
    expect(first.result()).toEqual({ status: 200, body: { data: { status: 'ok' } } });

    ready = false;
    const stopping = responseRecorder();
    await handler({ url: '/internal/health/ready' }, stopping.response);
    expect(stopping.result()).toEqual({
      status: 503,
      body: { data: { status: 'stopping' } },
    });
  });

  it('reports degraded readiness when PostgreSQL is unavailable', async () => {
    const handler = createMetricsHandler({
      db: {
        async query() {
          throw new Error('offline');
        },
      },
      registry: createMetricsRegistry(),
    });
    const recorder = responseRecorder();
    await handler({ url: '/internal/health/ready' }, recorder.response);
    expect(recorder.result()).toEqual({
      status: 503,
      body: { data: { status: 'degraded' } },
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError, createOnePicClient } from './index.js';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('OnePic client envelope handling', () => {
  it('returns data from a success envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ data: { status: 'ok' }, meta: { requestId: 'r1' } }),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    await expect(client.getHealthLive()).resolves.toEqual({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith(new URL('http://api.test/api/v1/health/live'), {
      signal: undefined,
    });
  });

  it('throws ApiRequestError with stable code and correlationId from error envelopes', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'rate_limited', message: 'slow down', correlationId: 'c-42' },
          }),
          { status: 429 },
        ),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const error = await client.getHealthReady().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    const apiError = error as ApiRequestError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe('rate_limited');
    expect(apiError.correlationId).toBe('c-42');
  });

  it('rejects non-JSON responses without echoing body content', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 502 }));
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const error = (await client.getHealthLive().catch((e: unknown) => e)) as ApiRequestError;
    expect(error.code).toBe('response_not_json');
    expect(error.message).not.toContain('oops');
  });

  it('rejects success envelopes missing data', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ meta: {} }));
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const error = (await client.getHealthReady().catch((e: unknown) => e)) as ApiRequestError;
    expect(error.code).toBe('response_envelope_invalid');
  });

  it('rejects error responses that do not follow the error envelope', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"weird":1}', { status: 400 }));
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const error = (await client.getHealthLive().catch((e: unknown) => e)) as ApiRequestError;
    expect(error.code).toBe('response_error_envelope_invalid');
  });
});

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
      method: 'GET',
      headers: {},
      body: undefined,
      signal: undefined,
      credentials: 'include',
    });
  });

  it('covers OIDC navigation, session operations, and signed binary media', async () => {
    const responses = [
      okResponse({
        data: {
          subject: {
            id: '3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e',
            role: 'member',
          },
        },
      }),
      okResponse({ data: { rotated: true } }),
      okResponse({ data: { loggedOut: true } }),
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = createOnePicClient({ baseUrl: 'https://api.test', fetchImpl });

    expect(client.getLoginUrl()).toBe('https://api.test/api/v1/auth/login');
    expect(client.getLoginCallbackUrl('code value', 'state/value')).toBe(
      'https://api.test/api/v1/auth/callback?code=code+value&state=state%2Fvalue',
    );
    await expect(client.getCurrentSubject()).resolves.toMatchObject({
      subject: { role: 'member' },
    });
    await expect(client.refreshSession()).resolves.toEqual({ rotated: true });
    await expect(client.logout()).resolves.toEqual({ loggedOut: true });
    const media = await client.getSignedMedia('/api/v1/media/b/k?owner=o&expires=1&signature=s');
    expect(media.contentType).toBe('image/png');
    expect([...new Uint8Array(media.bytes)]).toEqual([1, 2, 3]);

    expect(fetchImpl.mock.calls.map((call) => call[1]?.credentials)).toEqual([
      'include',
      'include',
      'include',
      'include',
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      'x-onepic-requested-with': 'onepic-fetch',
    });
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      'x-onepic-requested-with': 'onepic-fetch',
    });
  });

  it('sends the workbench calls with contract bodies, CSRF header, and idempotency key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        data: {
          id: 'g-1',
          state: 'queued',
          templateId: 'case-101',
          templateVersion: 1,
          createdAt: '2026-09-06T00:00:00Z',
        },
        meta: { pollAfterMs: 2000 },
      }),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const envelope = await client.createGeneration(
      {
        templateId: 'case-101',
        templateVersion: 1,
        promptSha256: 'a'.repeat(64),
        sourceObjectId: '3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e',
        settings: { model: 'gpt-image-2' },
      },
      'idem-key-0001',
    );
    expect(envelope.data.state).toBe('queued');
    expect(envelope.meta?.pollAfterMs).toBe(2000);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'x-onepic-requested-with': 'onepic-fetch',
      'idempotency-key': 'idem-key-0001',
      'content-type': 'application/json',
    });
  });

  it('fetches the generation traceability sidecar from the product endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        data: {
          schemaVersion: '1.0.0',
          kind: 'onepic-generation-sidecar',
          generationId: 'g/1',
          state: 'succeeded',
          template: { key: 'case-101', version: 1 },
          prompt: { compiledSha256: 'a'.repeat(64), effectiveSha256: 'a'.repeat(64) },
          input: { sha256: 'b'.repeat(64) },
          attempts: [],
          result: null,
          createdAt: '2026-09-06T00:00:00Z',
          completedAt: '2026-09-06T00:00:01Z',
        },
      }),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const sidecar = await client.getGenerationSidecar('g/1');

    expect(sidecar.kind).toBe('onepic-generation-sidecar');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://api.test/api/v1/generations/g%2F1/sidecar');
    expect(init?.method).toBe('GET');
  });

  it('sends cancelGeneration as a POST with the CSRF header and empty body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        data: {
          id: '3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e',
          state: 'cancelled',
          outcome: 'cancelled',
        },
      }),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const result = await client.cancelGeneration('3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e');
    expect(result.outcome).toBe('cancelled');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'http://api.test/api/v1/generations/3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e/cancel',
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'x-onepic-requested-with': 'onepic-fetch' });
  });

  it('sends deleteGeneration as a DELETE with the CSRF header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        data: {
          id: '3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e',
          deleted: true,
          state: 'succeeded',
        },
      }),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const result = await client.deleteGeneration('3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e');
    expect(result).toMatchObject({ deleted: true, state: 'succeeded' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'http://api.test/api/v1/generations/3f6b2c10-7b8f-4a1d-9c2e-5d4a6b7c8d9e',
    );
    expect(init?.method).toBe('DELETE');
    expect(init?.headers).toMatchObject({ 'x-onepic-requested-with': 'onepic-fetch' });
  });

  it('builds listGenerations query strings and surfaces meta.nextCursor', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        data: { items: [] },
        meta: { nextCursor: 'payload.signature' },
      }),
    );
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    const page = await client.listGenerations({ state: 'queued', cursor: 'a.b', limit: 10 });
    expect(page.meta?.nextCursor).toBe('payload.signature');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/v1/generations');
    expect(parsed.searchParams.get('state')).toBe('queued');
    expect(parsed.searchParams.get('cursor')).toBe('a.b');
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(init?.method).toBe('GET');
  });

  it('sends collection mutations with the CSRF header and correct routes', async () => {
    const responses = [
      { data: { id: 'c-1', name: 'n', createdAt: '2026-09-07T00:00:00Z', itemCount: 0 } },
      {
        data: {
          collectionId: 'c-1',
          itemType: 'template',
          itemKey: 'case-101',
          addedAt: '2026-09-07T00:00:00Z',
        },
      },
      { data: { collectionId: 'c-1', itemType: 'template', itemKey: 'case-101', removed: true } },
      { data: { id: 'c-1', deleted: true } },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(responses.shift()));
    const client = createOnePicClient({ baseUrl: 'http://api.test', fetchImpl });

    await client.createCollection({ name: 'n' });
    await client.addCollectionItem('c-1', { itemType: 'template', itemKey: 'case-101' });
    const removal = await client.removeCollectionItem('c-1', 'template', 'case-101');
    expect(removal.removed).toBe(true);
    await client.deleteCollection('c-1');

    const calls = fetchImpl.mock.calls;
    expect(String(calls[0]?.[0])).toBe('http://api.test/api/v1/collections');
    expect(calls[0]?.[1]?.method).toBe('POST');
    expect(String(calls[1]?.[0])).toBe('http://api.test/api/v1/collections/c-1/items');
    expect(String(calls[2]?.[0])).toBe(
      'http://api.test/api/v1/collections/c-1/items/template/case-101',
    );
    expect(calls[2]?.[1]?.method).toBe('DELETE');
    expect(String(calls[3]?.[0])).toBe('http://api.test/api/v1/collections/c-1');
    expect(calls[3]?.[1]?.method).toBe('DELETE');
    for (const call of calls) {
      expect(call[1]?.headers).toMatchObject({ 'x-onepic-requested-with': 'onepic-fetch' });
    }
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

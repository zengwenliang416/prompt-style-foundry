import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMockProvider, type MockProviderHandle } from '@onepic/test-support';

import { ProviderAdapter } from '../src/modules/generation/provider-adapter.js';

/**
 * J04 contract tests against the M01 mock provider (loopback only): request
 * shape, status normalization, redirect refusal, result-URL origin policy,
 * and credential non-leakage.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

let provider: MockProviderHandle;
beforeAll(async () => {
  provider = await startMockProvider();
});
afterAll(async () => {
  await provider?.close();
});

function adapter(): ProviderAdapter {
  return new ProviderAdapter(
    {
      providerId: 'direct-byok',
      label: 'BYOK',
      baseUrl: provider.baseUrl,
      apiKey: 'sk-j04-secret-key',
      models: [{ id: 'gpt-image-2', qualities: ['high'] }],
    },
    { fetchImpl: fetch },
  );
}

const baseRequest = {
  model: 'gpt-image-2',
  quality: 'high',
  prompt: 'test prompt',
  inputImage: PNG,
  inputMime: 'image/png',
};

describe('provider adapter (J04)', () => {
  it('normalizes a successful b64 response', async () => {
    const result = await adapter().generate(baseRequest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imageBytes.subarray(0, 4).toString('hex')).toBe('89504e47');
    }
    expect(provider.requests).toHaveLength(1);
    const recorded = provider.requests[0]!;
    expect(recorded.path).toBe('/v1/images/edits');
    const body = JSON.parse(recorded.body.toString());
    expect(body.model).toBe('gpt-image-2');
    expect(body.quality).toBe('high');
  });

  it('normalizes provider rejection status codes', async () => {
    provider.scriptResponses([
      { status: 401, body: '{"error":"bad key"}' },
      { status: 429, body: '{"error":"rate limited"}' },
      { status: 500, body: '{"error":"boom"}' },
    ]);
    const adapterInstance = adapter();

    const unauthorized = await adapterInstance.generate(baseRequest);
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) {
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.code).toBe('PROVIDER_REJECTED');
      // No Authorization material leaks into the normalized failure.
      expect(unauthorized.message).not.toContain('sk-j04-secret-key');
    }

    const limited = await adapterInstance.generate(baseRequest);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.status).toBe(429);
    }
  });

  it('maps 408/504 to PROVIDER_TIMEOUT_UNKNOWN (outcome unknown)', async () => {
    provider.scriptResponses([{ status: 504, body: '{}' }]);
    const result = await adapter().generate(baseRequest);
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_TIMEOUT_UNKNOWN' });
  });

  it('rejects non-allowlisted models before any request is sent', async () => {
    const requestsBefore = provider.requests.length;
    const result = await adapter().generate({ ...baseRequest, model: 'not-allowlisted' });
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_REJECTED' });
    expect(provider.requests.length).toBe(requestsBefore);
  });

  it('refuses provider redirects (SSRF guard)', async () => {
    provider.scriptResponses([]);
    const redirectTarget = `${provider.baseUrl}/redirect-to-internal`;
    // Script a raw 302 by monkey-patching the response queue body; the mock
    // always answers JSON, so use a dedicated adapter with a redirecting
    // fetch stub instead.
    const redirectingFetch: typeof fetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })) as unknown as typeof fetch;
    const redirectAdapter = new ProviderAdapter(
      {
        providerId: 'direct-byok',
        label: 'BYOK',
        baseUrl: provider.baseUrl,
        apiKey: 'sk-redirect-test',
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: redirectingFetch },
    );
    const result = await redirectAdapter.generate({ ...baseRequest });
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_REJECTED' });
    expect((result as { message?: string }).message).toContain('redirect');
    void redirectTarget;
  });

  it('rejects result URLs whose origin is not the allowlisted provider', async () => {
    // A malicious provider answering with a URL pointing at an internal target.
    provider.scriptResponses([
      {
        status: 200,
        body: JSON.stringify({ data: [{ url: 'http://169.254.169.254/latest/meta-data' }] }),
      },
    ]);
    const result = await adapter().generate(baseRequest);
    expect(result).toMatchObject({ ok: false, code: 'PROVIDER_REJECTED' });
  });
});

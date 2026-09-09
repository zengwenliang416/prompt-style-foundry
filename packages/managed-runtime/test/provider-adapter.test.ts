import { describe, expect, it, vi } from 'vitest';

import {
  credentialFreeMessage,
  ProviderAdapter,
  type GenerateRequest,
  type ProviderDescriptor,
} from '../src/provider-adapter.js';

const descriptor: ProviderDescriptor = {
  providerId: 'managed-test',
  label: 'Managed test provider',
  baseUrl: 'https://provider.example.test/configured/path',
  apiKey: 'sk-managed-runtime-secret',
  models: [{ id: 'gpt-image-2', qualities: ['high'] }],
};

const request: GenerateRequest = {
  model: 'gpt-image-2',
  quality: 'high',
  prompt: 'single-image\nprompt',
  inputImage: Buffer.from('input-image'),
  inputMime: 'image/png',
};

function successfulResponse(): Response {
  return new Response(
    JSON.stringify({ data: [{ b64_json: Buffer.from('output-image').toString('base64') }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function readField(body: Buffer, boundary: string, name: string): string | undefined {
  for (const part of body.toString('utf8').split(`--${boundary}`)) {
    if (!part.includes(`name="${name}"`)) continue;
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) return undefined;
    return part.slice(separator + 4).replace(/\r\n$/, '');
  }
  return undefined;
}

describe('ProviderAdapter shared runtime security contract', () => {
  it('uses the allowlisted origin, refuses redirects, scopes credentials, and forwards abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => successfulResponse());
    const adapter = new ProviderAdapter(descriptor, { fetchImpl });

    const outcome = await adapter.generate({ ...request, signal: controller.signal });

    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://provider.example.test/v1/images/edits');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: controller.signal });
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer sk-managed-runtime-secret',
    );
    const contentType = new Headers(init?.headers).get('content-type');
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(init?.body).toBeInstanceOf(Blob);
    const boundary = contentType!.slice(contentType!.indexOf('boundary=') + 9);
    const body = Buffer.from(await (init?.body as Blob).arrayBuffer());
    expect(readField(body, boundary, 'model')).toBe('gpt-image-2');
    expect(readField(body, boundary, 'quality')).toBe('high');
    expect(readField(body, boundary, 'prompt')).toBe('single-image\nprompt');
    expect(readField(body, boundary, 'n')).toBe('1');
    expect(readField(body, boundary, 'size')).toBe('auto');
    expect(readField(body, boundary, 'response_format')).toBe('b64_json');
    expect(body.includes(request.inputImage)).toBe(true);
  });

  it('rejects redirect responses and redirect errors without following the target', async () => {
    const responseFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
    );
    const responseOutcome = await new ProviderAdapter(descriptor, {
      fetchImpl: responseFetch,
    }).generate(request);
    expect(responseOutcome).toMatchObject({
      ok: false,
      code: 'PROVIDER_REJECTED',
      status: 302,
    });
    expect(responseFetch).toHaveBeenCalledTimes(1);

    const errorFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('redirect mode is set to error');
    });
    const errorOutcome = await new ProviderAdapter(descriptor, {
      fetchImpl: errorFetch,
    }).generate(request);
    expect(errorOutcome).toMatchObject({ ok: false, code: 'PROVIDER_REJECTED' });
    expect((errorOutcome as { message: string }).message).toContain('redirect');
    expect(errorFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-origin result URLs without fetching them (SSRF guard)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ url: 'http://169.254.169.254/latest/meta-data' }] }),
          { status: 200 },
        ),
    );
    const outcome = await new ProviderAdapter(descriptor, { fetchImpl }).generate(request);

    expect(outcome).toMatchObject({
      ok: false,
      code: 'PROVIDER_REJECTED',
      message: 'result URL origin is not allowlisted',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not issue a request for a non-allowlisted model', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => successfulResponse());
    const outcome = await new ProviderAdapter(descriptor, { fetchImpl }).generate({
      ...request,
      model: 'attacker-selected-model',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'PROVIDER_REJECTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps credentials out of normalized failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('socket closed while sending Bearer sk-managed-runtime-secret');
    });
    const outcome = await new ProviderAdapter(descriptor, { fetchImpl }).generate(request);

    expect(outcome).toEqual({
      ok: false,
      code: 'PROVIDER_TIMEOUT_UNKNOWN',
      message: 'provider request did not complete',
    });
    expect(JSON.stringify(outcome)).not.toContain(descriptor.apiKey);
    expect(credentialFreeMessage('Bearer sk-managed-runtime-secret')).toBe(
      'redacted provider error',
    );
  });
});

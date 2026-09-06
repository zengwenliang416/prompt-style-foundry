import { afterAll, describe, expect, it } from 'vitest';

import { startMockProvider } from './mock-provider.js';

describe('mock image-generation provider double', () => {
  const handles: Array<{ close(): Promise<void> }> = [];
  afterAll(async () => {
    for (const handle of handles) {
      await handle.close();
    }
  });

  it('records requests (including Authorization) and returns scripted errors', async () => {
    const provider = await startMockProvider();
    handles.push(provider);
    provider.scriptResponses([{ status: 429, body: JSON.stringify({ error: 'rate_limited' }) }]);

    const response = await fetch(`${provider.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-image-model', prompt: 'p' }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expect(provider.requests).toHaveLength(1);
    const recorded = provider.requests[0];
    expect(recorded?.path).toBe('/v1/images/generations');
    expect(recorded?.headers['authorization']).toBe('Bearer test-key');
    expect(recorded?.body.toString()).toContain('fake-image-model');
  });

  it('defaults to a valid PNG payload for success paths', async () => {
    const provider = await startMockProvider();
    handles.push(provider);

    const response = await fetch(`${provider.baseUrl}/v1/images/generations`, {
      method: 'POST',
      body: '{}',
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: Array<{ b64_json: string }> };
    const bytes = Buffer.from(payload.data[0]!.b64_json, 'base64');
    // PNG magic number: the success body must be a decodable image stub.
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});

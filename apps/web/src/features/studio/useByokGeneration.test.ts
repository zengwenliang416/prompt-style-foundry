// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useByokGeneration } from './useByokGeneration.js';
import {
  BYOK_KEY_STORAGE,
  SETTINGS_KEY,
  readByokApiKey,
  useSettingsStore,
} from '../../entities/settings/store.js';

/**
 * W05 direct-BYOK acceptance: requests go ONLY to the user-configured
 * endpoint, the key travels only as that request's Authorization header,
 * no cookies/credentials leave the origin, and no failure ever rewrites
 * the run mode or other settings.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function configureByok(): void {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      schemaVersion: 1,
      runMode: 'direct-byok',
      byokEndpoint: 'https://byok.user.example',
      byokModel: 'gpt-image-2',
      byokQuality: 'high',
    }),
  );
  localStorage.setItem(BYOK_KEY_STORAGE, JSON.stringify('sk-user-own-key'));
}

function inputFile(): File {
  return new File([PNG_BYTES], 'input.png', { type: 'image/png' });
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(response: () => Promise<Response>): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return await response();
    }),
  );
  return { calls };
}

describe('useByokGeneration (W05)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('posts image+prompt to the user endpoint only, with the key as Bearer and no credentials', async () => {
    configureByok();
    const { calls } = stubFetch(
      async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGk=' }] }), { status: 200 }),
    );
    const settings = useSettingsStore();
    settings.load();
    const byok = useByokGeneration();
    expect(byok.configured.value).toBe(true);

    await byok.start({ file: inputFile(), prompt: 'prompt-body' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // Base URL without /v1 gets it appended; the request never touches /api/*.
    expect(call!.url).toBe('https://byok.user.example/v1/images/edits');
    expect(call!.url).not.toContain('/api/');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({ Authorization: 'Bearer sk-user-own-key' });
    // Default credentials ('same-origin'): never explicitly included, so a
    // cross-origin endpoint never receives the session cookie.
    expect(call!.init.credentials).toBeUndefined();

    const form = call!.init.body as FormData;
    expect(form.get('prompt')).toBe('prompt-body');
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('quality')).toBe('high');
    expect(form.get('n')).toBe('1');
    expect((form.get('image') as File).name).toBe('input.png');

    expect(byok.phase.value).toBe('succeeded');
    expect(byok.result.value).toEqual({ src: 'data:image/png;base64,aGk=' });
  });

  it('keeps an endpoint already ending in /v1 unchanged', async () => {
    configureByok();
    const settings = useSettingsStore();
    settings.load();
    settings.setByokConfig('https://byok.user.example/v1/', 'gpt-image-2', 'auto');
    const { calls } = stubFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ url: 'https://cdn.user.example/x.png' }] }), {
          status: 200,
        }),
    );
    const byok = useByokGeneration();

    await byok.start({ file: inputFile(), prompt: 'p' });

    expect(calls[0]!.url).toBe('https://byok.user.example/v1/images/edits');
    // quality=auto is not sent.
    expect((calls[0]!.init.body as FormData).get('quality')).toBeNull();
    expect(byok.result.value).toEqual({ src: 'https://cdn.user.example/x.png' });
  });

  it('reports 429 in place and never auto-switches the run mode or drops the key', async () => {
    configureByok();
    stubFetch(
      async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }),
    );
    const settings = useSettingsStore();
    settings.load();
    const byok = useByokGeneration();

    await byok.start({ file: inputFile(), prompt: 'p' });

    expect(byok.phase.value).toBe('failed');
    expect(byok.error.value).toContain('429');
    expect(settings.runMode).toBe('direct-byok');
    expect(readByokApiKey()).toBe('sk-user-own-key');
  });

  it('maps network failure (TypeError) to the CORS/unreachable hint without touching settings', async () => {
    configureByok();
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const settings = useSettingsStore();
    settings.load();
    const byok = useByokGeneration();

    await byok.start({ file: inputFile(), prompt: 'p' });

    expect(byok.phase.value).toBe('failed');
    expect(byok.error.value).toContain('CORS');
    expect(settings.runMode).toBe('direct-byok');
  });

  it('refuses to run unconfigured: honest error and zero network requests', async () => {
    const { calls } = stubFetch(async () => new Response('{}'));
    const settings = useSettingsStore();
    settings.load();
    const byok = useByokGeneration();
    expect(byok.configured.value).toBe(false);

    await byok.start({ file: inputFile(), prompt: 'p' });

    expect(byok.phase.value).toBe('failed');
    expect(byok.error.value).toContain('配置');
    expect(calls).toHaveLength(0);
  });
});

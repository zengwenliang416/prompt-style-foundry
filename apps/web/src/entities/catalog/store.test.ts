// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCatalogStore } from './store.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function makeCatalog(version: string, ids: string[]): unknown {
  return {
    schemaVersion: '1.1.0',
    generatedAt: version,
    project: { name: 't', nameZh: 't', description: 't' },
    source: { project: 's', repository: 'r', archiveSha256: 'a', license: 'MIT' },
    stats: { total: ids.length, cases: ids.length, frameworks: 0 },
    filters: { categories: [], modes: [], blueprintInputModes: [], styles: [], scenes: [] },
    templates: ids.map((id) => ({
      id,
      title: `T ${id}`,
      kind: 'case',
      category: 'C',
      styles: [],
      scenes: [],
      tags: [],
      language: 'zh',
      mode: 'poster',
      blueprintInputMode: 'text-to-image',
      requiresText: false,
      preview: `previews/${id}.webp`,
      generatedPreview: null,
      generatedPromptPath: null,
      promptPath: `prompts/${id}.txt`,
      source: null,
      promptSha256: `sha-${id}-${version}`,
    })),
  };
}

/** fetch stub that records every URL and serves canned responses. */
function stubFetch(routes: Record<string, Response | (() => Response)>): {
  urls: string[];
} {
  const urls: string[] = [];
  const impl = vi.fn(async (input: URL | string | Request) => {
    const raw = input instanceof Request ? input.url : String(input);
    urls.push(raw);
    // Normalize absolute and relative URLs to a pathname key.
    const path = raw.startsWith('http')
      ? new URL(raw).pathname
      : raw.startsWith('/')
        ? raw
        : `/${raw}`;
    const route = routes[path];
    if (route === undefined) {
      return new Response('not found', { status: 404 });
    }
    return typeof route === 'function' ? route() : route;
  });
  vi.stubGlobal('fetch', impl);
  return { urls };
}

describe('catalog store (U03)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
  });

  it('loads the catalog without fetching any prompt TXT at init', async () => {
    const { urls } = stubFetch({
      '/data/catalog.json': jsonResponse(makeCatalog('v1', ['case-1', 'case-2'])),
    });
    const store = useCatalogStore();

    await store.load();

    expect(store.status).toBe('ready');
    expect(store.templates).toHaveLength(2);
    expect(store.version).toBe('1.1.0#v1');
    // Acceptance: initial load never pulls prompt bodies.
    expect(urls.filter((url) => url.endsWith('.txt'))).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('fetches prompt bodies on demand and caches by id+hash', async () => {
    const { urls } = stubFetch({
      '/data/catalog.json': jsonResponse(makeCatalog('v1', ['case-1'])),
      '/data/prompts/case-1.txt': textResponse('[System / Prompt] body'),
    });
    const store = useCatalogStore();
    await store.load();

    const first = await store.loadPromptText('case-1');
    const second = await store.loadPromptText('case-1');

    expect(first).toBe('[System / Prompt] body');
    expect(second).toBe(first);
    expect(urls.filter((url) => url.endsWith('.txt'))).toHaveLength(1);
    expect(store.promptStatus('case-1')).toBe('ready');
  });

  it('marks prompt failures per-template and allows retry', async () => {
    let fail = true;
    const { urls } = stubFetch({
      '/data/catalog.json': jsonResponse(makeCatalog('v1', ['case-1'])),
      '/data/prompts/case-1.txt': () =>
        fail ? new Response('server error', { status: 500 }) : textResponse('ok body'),
    });
    const store = useCatalogStore();
    await store.load();

    await expect(store.loadPromptText('case-1')).rejects.toThrow();
    expect(store.promptStatus('case-1')).toBe('error');

    fail = false;
    const text = await store.loadPromptText('case-1');
    expect(text).toBe('ok body');
    expect(urls.filter((url) => url.endsWith('.txt'))).toHaveLength(2);
  });

  it('rejecting a prompt for a template outside the catalog is an error', async () => {
    stubFetch({ '/data/catalog.json': jsonResponse(makeCatalog('v1', ['case-1'])) });
    const store = useCatalogStore();
    await store.load();

    await expect(store.loadPromptText('case-999')).rejects.toThrow();
    expect(store.promptStatus('case-999')).toBe('error');
  });

  it('recovers from a failed catalog request by retrying load()', async () => {
    let healthy = false;
    stubFetch({
      '/data/catalog.json': () =>
        healthy
          ? jsonResponse(makeCatalog('v1', ['case-1']))
          : new Response('boom', { status: 500 }),
    });
    const store = useCatalogStore();

    await store.load();
    expect(store.status).toBe('error');
    expect(store.error).toContain('目录加载失败');

    healthy = true;
    await store.load();
    expect(store.status).toBe('ready');
    expect(store.templates).toHaveLength(1);
  });

  it('recovers when the cached version is replaced by a newer build', async () => {
    let version = 'v1';
    stubFetch({
      '/data/catalog.json': () =>
        jsonResponse(
          makeCatalog(version, version === 'v1' ? ['case-1'] : ['case-1', 'case-2', 'case-3']),
        ),
    });
    const store = useCatalogStore();
    await store.load();
    expect(store.version).toBe('1.1.0#v1');

    version = 'v2';
    await store.load();
    expect(store.status).toBe('ready');
    expect(store.version).toBe('1.1.0#v2');
    expect(store.templates).toHaveLength(3);
  });

  it('treats an empty catalog as a recoverable empty state', async () => {
    let empty = true;
    stubFetch({
      '/data/catalog.json': () =>
        empty ? jsonResponse(makeCatalog('v1', [])) : jsonResponse(makeCatalog('v1', ['case-1'])),
    });
    const store = useCatalogStore();

    await store.load();
    expect(store.status).toBe('empty');
    expect(store.templates).toHaveLength(0);

    empty = false;
    await store.load();
    expect(store.status).toBe('ready');
    expect(store.templates).toHaveLength(1);
  });

  it('rejects a malformed catalog payload as an error, not a crash', async () => {
    stubFetch({ '/data/catalog.json': textResponse('<html>proxy error</html>') });
    const store = useCatalogStore();

    await store.load();
    expect(store.status).toBe('error');
    expect(store.error).toContain('目录加载失败');
  });
});

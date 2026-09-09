// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import WorkspacePage from './WorkspacePage.vue';
import { createAppRouter } from '../../app/router.js';
import { useSettingsStore } from '../../entities/settings/store.js';
import { LOCAL_RECORD_KEY } from '../../shared/platform/local-store.js';
import { toastState, dismissToast } from '../../shared/ui/toast.js';

const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }));
vi.mock('../../shared/platform/download.js', () => ({
  downloadTextFile: downloadMock,
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeCatalog(): unknown {
  return {
    schemaVersion: '1.1.0',
    generatedAt: 'v1',
    project: { name: 't', nameZh: 't', description: 't' },
    source: { project: 's', repository: 'r', archiveSha256: 'a', license: 'MIT' },
    stats: { total: 2, cases: 2, frameworks: 0 },
    filters: { categories: [], modes: [], blueprintInputModes: [], styles: [], scenes: [] },
    templates: [1, 2].map((i) => ({
      id: `case-${i}`,
      title: `模板 ${i}`,
      kind: 'case',
      category: 'C',
      styles: [],
      scenes: [],
      tags: [],
      language: 'zh',
      mode: 'poster',
      blueprintInputMode: 'text-to-image',
      requiresText: false,
      preview: `/previews/case-${i}.webp`,
      generatedPreview: `/previews/case-${i}.webp`,
      generatedPromptPath: null,
      promptPath: '',
      source: null,
      promptSha256: `sha-${i}`,
    })),
  };
}

async function mountWorkspace(): Promise<ReturnType<typeof mount>> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createAppRouter({ history: createMemoryHistory() }).getRoutes(),
  });
  await router.push('/workspace');
  await router.isReady();
  const wrapper = mount(WorkspacePage, { global: { plugins: [router] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
  return wrapper;
}

function clearToasts(): void {
  for (const item of [...toastState.items]) {
    dismissToast(item.id);
  }
}

describe('WorkspacePage (U10)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    localStorage.clear();
    clearToasts();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(makeCatalog())),
    );
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('shows honest empty states for favorites, recent, records, and collections', async () => {
    const wrapper = await mountWorkspace();
    expect(wrapper.text()).toContain('暂无本地收藏');
    expect(wrapper.text()).toContain('暂无最近查看');
    expect(wrapper.text()).toContain('还没有本地生成记录');
    expect(wrapper.text()).toContain('暂无本地集合');
  });

  it('lists favorited templates with an unfavorite action', async () => {
    localStorage.setItem(
      LOCAL_RECORD_KEY,
      JSON.stringify({ schemaVersion: 1, favorites: ['case-1'], recent: [], collections: [] }),
    );
    const wrapper = await mountWorkspace();

    expect(wrapper.find('a[href="/studio/case-1"]').exists()).toBe(true);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '取消收藏')!
      .trigger('click');
    await wrapper.vm.$nextTick();

    const record = JSON.parse(localStorage.getItem(LOCAL_RECORD_KEY) ?? '{}');
    expect(record.favorites).toEqual([]);
    expect(wrapper.text()).toContain('暂无本地收藏');
  });

  it('creates and deletes a collection', async () => {
    const wrapper = await mountWorkspace();

    await wrapper
      .findAll('input')
      .find((i) => i.attributes('placeholder') === '例如：产品图灵感')!
      .setValue('我的集合');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '创建集合')!
      .trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('我的集合');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '删除')!
      .trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('暂无本地集合');
  });

  it('renders a markup-carrying collection name as inert text (O03 XSS negative)', async () => {
    const wrapper = await mountWorkspace();
    const xssName = `<script>window.__o03xss = true</script><img src=x onerror="window.__o03xss = true">`;

    await wrapper
      .findAll('input')
      .find((i) => i.attributes('placeholder') === '例如：产品图灵感')!
      .setValue(xssName);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '创建集合')!
      .trigger('click');
    await wrapper.vm.$nextTick();

    // Vue interpolation escapes by default: the markup is visible text, never DOM.
    expect(wrapper.text()).toContain('<script>window.__o03xss = true</script>');
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.find('img[src="x"]').exists()).toBe(false);
    expect((window as unknown as Record<string, unknown>)['__o03xss']).toBeUndefined();
  });

  it('exports a record download that never contains the BYOK key', async () => {
    localStorage.setItem(
      LOCAL_RECORD_KEY,
      JSON.stringify({ schemaVersion: 1, favorites: ['case-1'], recent: [], collections: [] }),
    );
    localStorage.setItem('onepic.byok.key.v1', JSON.stringify('sk-must-not-leak'));

    const wrapper = await mountWorkspace();

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '导出本地记录')!
      .trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [filename, content] = downloadMock.mock.calls[0] as [string, string];
    expect(filename).toContain('onepic-local-record-');
    const exported = JSON.parse(content) as { schemaVersion: number; favorites: string[] };
    expect(exported.favorites).toEqual(['case-1']);
    expect(content).not.toContain('sk-must-not-leak');
  });

  it('imports a valid record and reports the merge counts', async () => {
    const wrapper = await mountWorkspace();
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');
    const payload = JSON.stringify({
      schemaVersion: 1,
      favorites: ['case-1', 'case-1', 'case-2'],
      recent: [{ id: 'case-1', viewedAt: '2026-09-06T00:00:00.000Z' }],
      collections: [],
    });

    Object.defineProperty(input.element, 'files', {
      value: [
        new File([payload], 'record.json', {
          type: 'application/json',
        }),
      ],
      configurable: true,
    });
    await input.trigger('change');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(toastState.items.some((item) => item.message.includes('导入完成'))).toBe(true);
    const record = JSON.parse(localStorage.getItem(LOCAL_RECORD_KEY) ?? '{}');
    // Duplicate favorite ids are merged.
    expect(record.favorites).toEqual(['case-1', 'case-2']);
    expect(wrapper.text()).toContain('本地收藏（2）');
  });

  it('rejects bad JSON imports with explicit feedback and no data loss', async () => {
    localStorage.setItem(
      LOCAL_RECORD_KEY,
      JSON.stringify({ schemaVersion: 1, favorites: ['case-1'], recent: [], collections: [] }),
    );
    const wrapper = await mountWorkspace();
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');

    Object.defineProperty(input.element, 'files', {
      value: [new File(['{broken'], 'bad.json', { type: 'application/json' })],
      configurable: true,
    });
    await input.trigger('change');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      toastState.items.some(
        (item) => item.tone === 'error' && item.message.includes('不是有效 JSON'),
      ),
    ).toBe(true);
    const record = JSON.parse(localStorage.getItem(LOCAL_RECORD_KEY) ?? '{}');
    expect(record.favorites).toEqual(['case-1']);
  });

  it('rejects schema-version mismatches explicitly', async () => {
    const wrapper = await mountWorkspace();
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');

    Object.defineProperty(input.element, 'files', {
      value: [
        new File([JSON.stringify({ schemaVersion: 99, favorites: [] })], 'future.json', {
          type: 'application/json',
        }),
      ],
      configurable: true,
    });
    await input.trigger('change');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toastState.items.some((item) => item.message.includes('schema 版本不符'))).toBe(true);
  });

  it('reports unavailable storage on import instead of losing data silently', async () => {
    const wrapper = await mountWorkspace();
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');

    // Make writes fail after load (storage becomes unavailable mid-session).
    const throwingSet = vi.fn(() => {
      throw new Error('quota');
    });
    const original = localStorage.setItem.bind(localStorage);
    Object.defineProperty(localStorage, 'setItem', { value: throwingSet, configurable: true });

    Object.defineProperty(input.element, 'files', {
      value: [
        new File(
          [
            JSON.stringify({
              schemaVersion: 1,
              favorites: ['case-2'],
              recent: [],
              collections: [],
            }),
          ],
          'ok.json',
          { type: 'application/json' },
        ),
      ],
      configurable: true,
    });
    await input.trigger('change');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      toastState.items.some((item) => item.message.includes('本地存储不可用，导入未能保存')),
    ).toBe(true);
    Object.defineProperty(localStorage, 'setItem', { value: original, configurable: true });
  });

  it('keeps the server-import button disabled outside managed mode', async () => {
    useSettingsStore().setRunMode('catalog-only');
    const wrapper = await mountWorkspace();

    const button = wrapper.find('button.workspace__server-import');
    expect(button.exists()).toBe(true);
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Disabled button never fires the handler: no toast, no API call beyond catalog load.
    expect(toastState.items.some((item) => item.message.includes('托管模式'))).toBe(false);
  });

  it('imports the local record to the server explicitly and renders the per-item report', async () => {
    useSettingsStore().setRunMode('managed-generation');
    localStorage.setItem(
      LOCAL_RECORD_KEY,
      JSON.stringify({
        schemaVersion: 1,
        favorites: ['case-1'],
        recent: [],
        collections: [{ id: 'local-1', name: '海报灵感', templateIds: ['case-2'] }],
      }),
    );
    localStorage.setItem('onepic.byok.key.v1', JSON.stringify('sk-must-not-leak'));

    const apiCalls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const collections = new Map<string, { id: string; itemCount: number }>();
    let sequence = 0;
    // The shared beforeEach replaces global URL with a plain object (for
    // createObjectURL); the import path needs the real constructor.
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (!url.pathname.startsWith('/api/')) {
          return jsonResponse(makeCatalog());
        }
        apiCalls.push({
          url: url.pathname,
          method: (init?.method ?? 'GET').toUpperCase(),
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (url.pathname === '/api/v1/collections' && init?.method === 'POST') {
          const name = (JSON.parse(init.body as string) as { name: string }).name;
          const existing = collections.get(name);
          if (existing !== undefined) {
            return new Response(
              JSON.stringify({
                error: { code: 'COLLECTION_NAME_CONFLICT', message: 'dup', correlationId: 'c' },
              }),
              { status: 409 },
            );
          }
          sequence += 1;
          const id = `00000000-0000-0000-0000-${String(sequence).padStart(12, '0')}`;
          collections.set(name, { id, itemCount: 0 });
          return new Response(
            JSON.stringify({
              data: { id, name, createdAt: '2026-09-07T00:00:00.000Z', itemCount: 0 },
            }),
            { status: 201 },
          );
        }
        if (url.pathname === '/api/v1/collections' && (init?.method ?? 'GET') === 'GET') {
          const items = [...collections.entries()].map(([name, c]) => ({
            id: c.id,
            name,
            createdAt: '2026-09-07T00:00:00.000Z',
            itemCount: c.itemCount,
          }));
          return jsonResponse({ data: { items }, meta: {} });
        }
        const itemsMatch = /^\/api\/v1\/collections\/([^/]+)\/items$/.exec(url.pathname);
        if (itemsMatch !== null && init?.method === 'POST') {
          const entry = [...collections.values()].find((c) => c.id === itemsMatch[1]);
          if (entry !== undefined) {
            entry.itemCount += 1;
          }
          const parsed = JSON.parse(init.body as string) as { itemKey: string };
          return jsonResponse({
            data: {
              collectionId: itemsMatch[1],
              itemType: 'template',
              itemKey: parsed.itemKey,
              addedAt: '2026-09-07T00:00:00.000Z',
            },
          });
        }
        return new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'nope', correlationId: 'c' } }),
          { status: 404 },
        );
      }),
    );

    const wrapper = await mountWorkspace();
    const button = wrapper.find('button.workspace__server-import');
    expect(button.attributes('disabled')).toBeUndefined();

    await button.trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    // Explicit trigger only: 2 collection creates + 2 item adds + 2 recount
    // GETs (itemCount delta) — no other traffic.
    expect(apiCalls).toHaveLength(6);
    expect(
      apiCalls.filter((c) => c.method === 'POST' && c.url === '/api/v1/collections'),
    ).toHaveLength(2);
    expect(apiCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/items'))).toHaveLength(2);
    expect(apiCalls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(toastState.items.some((item) => item.message.includes('已导入服务器'))).toBe(true);
    expect(wrapper.find('.workspace__server-report').exists()).toBe(true);
    expect(wrapper.text()).toContain('条目新增 2');

    // The BYOK key never enters any request.
    for (const call of apiCalls) {
      expect(call.body ?? '').not.toContain('sk-must-not-leak');
      expect(call.url).not.toContain('sk-must-not-leak');
    }
  });
});

// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import WorkspacePage from './WorkspacePage.vue';
import { createAppRouter } from '../../app/router.js';
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
});

// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import HomePage from './HomePage.vue';
import { createAppRouter } from '../../app/router.js';
import { LOCAL_RECORD_KEY } from '../../shared/platform/local-store.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeCatalog(): unknown {
  const templates = [1, 2, 3, 4, 5].map((i) => ({
    id: `case-${i}`,
    title: `模板 ${i}`,
    kind: 'case',
    category: 'C',
    styles: [],
    scenes: [],
    tags: [],
    language: 'zh',
    mode: 'poster',
    blueprintInputMode: i % 2 === 0 ? 'image-to-image' : 'text-to-image',
    requiresText: false,
    preview: `/previews/case-${i}.webp`,
    generatedPreview: `/previews/case-${i}.webp`,
    generatedPromptPath: null,
    promptPath: '',
    source: null,
    promptSha256: `sha-${i}`,
  }));
  return {
    schemaVersion: '1.1.0',
    generatedAt: 'v1',
    project: { name: 't', nameZh: 't', description: 't' },
    source: { project: 's', repository: 'r', archiveSha256: 'a', license: 'MIT' },
    stats: { total: 5, cases: 5, frameworks: 0 },
    filters: {
      categories: [],
      modes: [],
      blueprintInputModes: ['text-to-image', 'image-to-image'],
      styles: [],
      scenes: [],
    },
    templates,
  };
}

async function mountHome(): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createAppRouter({ history: createMemoryHistory() }).getRoutes(),
  });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(HomePage, { global: { plugins: [router] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
  return { wrapper, router };
}

describe('HomePage (U06)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(makeCatalog())),
    );
  });

  it('shows real catalog statistics and never fakes service metrics', async () => {
    const { wrapper } = await mountHome();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('全部模板');
    });

    const values = wrapper.findAll('.home__stat-value').map((node) => node.text());
    expect(values).toEqual(['5', '3', '2', '0']);
    // Honest service line: no fabricated online users or task counters.
    expect(wrapper.text()).toContain('本地模式：未连接生成服务');
    expect(wrapper.text()).not.toContain('在线');
    expect(wrapper.text()).not.toContain('任务数');
  });

  it('shows the empty recent state on first visit', async () => {
    const { wrapper } = await mountHome();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('最近查看');
    });
    expect(wrapper.text()).toContain('暂无最近查看的模板');
  });

  it('surfaces recent views recorded locally', async () => {
    localStorage.setItem(
      LOCAL_RECORD_KEY,
      JSON.stringify({
        schemaVersion: 1,
        favorites: [],
        recent: [{ id: 'case-2', viewedAt: '2026-09-06T00:00:00.000Z' }],
      }),
    );
    const { wrapper } = await mountHome();
    await vi.waitFor(() => {
      expect(wrapper.find('.home__recent-link').exists()).toBe(true);
    });
    expect(wrapper.find('.home__recent-id').text()).toBe('case-2');
    expect(wrapper.find('a[href="/studio/case-2"]').exists()).toBe(true);
  });

  it('warns honestly when localStorage is unavailable', async () => {
    const throwing = {
      get length(): number {
        throw new Error('blocked');
      },
      getItem(): string | null {
        throw new Error('blocked');
      },
      setItem(): void {
        throw new Error('blocked');
      },
      clear(): void {},
      key(): string | null {
        return null;
      },
      removeItem(): void {},
    };
    vi.stubGlobal('localStorage', throwing);

    const { wrapper } = await mountHome();
    expect(wrapper.text()).toContain('本地存储不可用');
  });

  it('mentions the corrupted-record fallback honestly', async () => {
    localStorage.setItem(LOCAL_RECORD_KEY, '{bad json');
    const { wrapper } = await mountHome();
    expect(wrapper.text()).toContain('本地记录格式无法识别，已按空记录处理');
  });

  it('renders the three-step usage flow and a discover entry', async () => {
    const { wrapper } = await mountHome();
    expect(wrapper.text()).toContain('01 选模板');
    expect(wrapper.text()).toContain('02 上传一张图');
    expect(wrapper.text()).toContain('03 确认生成');
    expect(wrapper.find('a[href="/discover"]').exists()).toBe(true);
  });

  it('exposes the store error state with a retry when the catalog fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const { wrapper } = await mountHome();
    await vi.waitFor(() => {
      expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    });
    expect(wrapper.find('[role="alert"]').text()).toContain('目录加载失败');
    expect(wrapper.findAll('button').some((b) => b.text() === '重试')).toBe(true);
  });
});

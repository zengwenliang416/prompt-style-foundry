// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import DiscoverPage from './DiscoverPage.vue';
import { createAppRouter } from '../../app/router.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeCatalog(): unknown {
  const ids = Array.from({ length: 30 }, (_, i) => `case-${i + 1}`);
  return {
    schemaVersion: '1.1.0',
    generatedAt: 'v1',
    project: { name: 't', nameZh: 't', description: 't' },
    source: { project: 's', repository: 'r', archiveSha256: 'a', license: 'MIT' },
    stats: { total: ids.length + 1, cases: ids.length, frameworks: 1 },
    filters: {
      categories: ['Posters & Typography', 'UI & Interfaces'],
      modes: ['poster'],
      blueprintInputModes: ['text-to-image', 'image-to-image'],
      styles: [],
      scenes: [],
    },
    templates: [
      ...ids.map((id) => ({
        id,
        title: `模板 ${id}`,
        kind: 'case',
        category: 'Posters & Typography',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        preview: `/previews/${id}.webp`,
        generatedPreview: null,
        generatedPromptPath: null,
        promptPath: '',
        source: null,
        promptSha256: `sha-${id}`,
      })),
      {
        id: 'framework-001',
        title: '界面模板',
        kind: 'framework',
        category: 'UI & Interfaces',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'interface',
        blueprintInputMode: 'image-to-image',
        requiresText: false,
        preview: '/previews/framework-001.webp',
        generatedPreview: null,
        generatedPromptPath: null,
        promptPath: '',
        source: null,
        promptSha256: 'sha-framework-001',
      },
    ],
  };
}

async function mountDiscover(initialQuery: Record<string, string> = {}): Promise<{
  wrapper: ReturnType<typeof mount>;
  router: Router;
}> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createAppRouter({ history: createMemoryHistory() }).getRoutes(),
  });
  await router.push({ path: '/discover', query: initialQuery });
  await router.isReady();
  const wrapper = mount(DiscoverPage, { global: { plugins: [router] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { wrapper, router };
}

describe('DiscoverPage (U04)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(makeCatalog())),
    );
  });

  it('shows an incremental subset first and loads more on demand', async () => {
    const { wrapper } = await mountDiscover();

    const cards = wrapper.findAll('.discover__card');
    expect(cards.length).toBeLessThanOrEqual(24);
    expect(wrapper.text()).toContain('还有');

    await wrapper.find('.discover__more button').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.discover__card').length).toBeGreaterThan(24);
  });

  it('filters by blueprint type via chips (catalog property, not run modes)', async () => {
    const { wrapper } = await mountDiscover();
    await wrapper.vm.$nextTick();

    const chips = wrapper.findAll('.discover__group')[0]!.findAll('.chip');
    // 全部 + 文生图蓝图 + 图生图蓝图
    expect(chips).toHaveLength(3);
    await chips[2]!.trigger('click');
    await wrapper.vm.$nextTick();

    const badges = wrapper.findAll('.discover__card-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.text()).toBe('图生图蓝图');
    expect(wrapper.text()).toContain('共 1 个模板');
  });

  it('shows a no-results state with a clear action that restores the full list', async () => {
    const { wrapper } = await mountDiscover();

    await wrapper.find('.discover__search').setValue('不存在的关键词xyz');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('没有符合条件的结果');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '清空筛选')!
      .trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.discover__card').length).toBeGreaterThan(0);
  });

  it('restores filters from the URL query on load', async () => {
    const { wrapper, router } = await mountDiscover({ q: '界面', mode: 'image-to-image' });

    expect(wrapper.findAll('.discover__card')).toHaveLength(1);
    expect(wrapper.find('.discover__search').element as HTMLInputElement).toBeDefined();
    const search = wrapper.find<HTMLInputElement>('.discover__search');
    expect(search.element.value).toBe('界面');
    expect(router.currentRoute.value.query['mode']).toBe('image-to-image');
  });

  it('writes filter changes back to the URL (shareable search)', async () => {
    const { wrapper, router } = await mountDiscover();

    await wrapper.find('.discover__search').setValue('case-3');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(router.currentRoute.value.query['q']).toBe('case-3');
    expect(router.currentRoute.value.query['mode']).toBeUndefined();
  });

  it('renders cards with title, id, badge and a link to the workbench', async () => {
    const { wrapper } = await mountDiscover();

    const firstCard = wrapper.find('.discover__card');
    expect(firstCard.find('h2').text()).toContain('模板 case-1');
    expect(firstCard.find('.discover__card-id').text()).toBe('case-1');
    expect(firstCard.find('.discover__card-badge--text-to-image').exists()).toBe(true);
    expect(firstCard.find('a[href="/studio/case-1"]').exists()).toBe(true);
    expect(firstCard.find('.discover__card-cta').text()).toBe('查看模板');
  });

  it('uses the lazy image for previews', async () => {
    const { wrapper } = await mountDiscover();
    expect(wrapper.find('.discover__card img').attributes('loading')).toBe('lazy');
  });
});

// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';

import App from './App.vue';
import { createAppRouter } from './router.js';

async function mountApp(initialPath: string): Promise<{ router: Router; wrapper: VueWrapper }> {
  const router = createAppRouter({ history: createMemoryHistory() });
  await router.push(initialPath);
  await router.isReady();
  // Pages like /discover touch Pinia and the catalog API; provide both so the
  // shell assertions run against a rendered app instead of an error state.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ schemaVersion: '1.1.0', generatedAt: 'v', templates: [] }), {
          status: 200,
        }),
    ),
  );
  const wrapper = mount(App, { global: { plugins: [router, createPinia()] } });
  return { router, wrapper };
}

describe('router (U02)', () => {
  it('resolves the five routes to their pages', async () => {
    const { router } = await mountApp('/');

    expect(router.currentRoute.value.name).toBe('home');
    await router.push('/discover');
    expect(router.currentRoute.value.name).toBe('discover');
    await router.push('/workspace');
    expect(router.currentRoute.value.name).toBe('workspace');
    await router.push('/guide');
    expect(router.currentRoute.value.name).toBe('guide');
  });

  it('resolves deep links with route params (/studio/case-1)', async () => {
    const { router } = await mountApp('/studio/case-1');
    expect(router.currentRoute.value.name).toBe('studio');
    expect(router.currentRoute.value.params['templateId']).toBe('case-1');
  });

  it('lands on the studio placeholder when no template is selected', async () => {
    const { wrapper } = await mountApp('/studio');
    expect(wrapper.find('#main-content').text()).toContain('尚未选择模板');
  });

  it('renders the 404 page for unknown paths', async () => {
    const { wrapper } = await mountApp('/no/such/page');
    const main = wrapper.find('#main-content');
    expect(main.text()).toContain('404');
    expect(main.find('a[href="/"]').exists()).toBe(true);
  });

  it('supports back/forward navigation', async () => {
    const { router } = await mountApp('/');

    await router.push('/discover');
    await router.push('/guide');

    // back()/forward() return void; wait for the navigation they trigger.
    async function expectHistoryNavigation(action: () => void, expected: string): Promise<void> {
      const done = new Promise<void>((resolve) => {
        const unsubscribe = router.afterEach(() => {
          unsubscribe();
          resolve();
        });
      });
      action();
      await done;
      expect(router.currentRoute.value.name).toBe(expected);
    }

    await expectHistoryNavigation(() => router.back(), 'discover');
    await expectHistoryNavigation(() => router.forward(), 'guide');
  });

  it('renders the shell with five nav links and exact aria-current', async () => {
    const { wrapper } = await mountApp('/discover');

    const nav = wrapper.find('nav[aria-label="主导航"]');
    const links = nav.findAll('a');
    expect(links).toHaveLength(5);
    const current = links.filter((link) => link.attributes('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.text()).toBe('模板发现');
  });

  it('provides a skip link to the main content', async () => {
    const { wrapper } = await mountApp('/');
    expect(wrapper.find('a[href="#main-content"]').text()).toContain('跳到主要内容');
  });
});

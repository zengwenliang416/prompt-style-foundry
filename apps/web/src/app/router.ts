import { createRouter, createWebHistory, type RouterOptions } from 'vue-router';

import DiscoverPage from '../features/discover/DiscoverPage.vue';
import StudioPage from '../features/studio/StudioPage.vue';
import HomePage from '../features/home/HomePage.vue';
import GuidePage from '../features/guide/GuidePage.vue';
import NotFoundPage from './pages/NotFoundPage.vue';
import WorkspacePage from '../features/workspace/WorkspacePage.vue';

/**
 * Five-route navigation (architecture §5). History mode keeps shareable,
 * refreshable deep links; static hosts need SPA fallback (vite preview and
 * the dev server provide it; deployment wiring lands with O05).
 */
export function createAppRouter(options?: Pick<RouterOptions, 'history'>) {
  return createRouter({
    history: options?.history ?? createWebHistory(),
    routes: [
      { path: '/', name: 'home', component: HomePage },
      { path: '/discover', name: 'discover', component: DiscoverPage },
      // Optional param: the workbench nav entry has no template yet and
      // StudioPage shows a "pick a template first" state in that case.
      { path: '/studio/:templateId?', name: 'studio', component: StudioPage },
      { path: '/workspace', name: 'workspace', component: WorkspacePage },
      { path: '/guide', name: 'guide', component: GuidePage },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundPage },
    ],
    scrollBehavior() {
      return { top: 0 };
    },
  });
}

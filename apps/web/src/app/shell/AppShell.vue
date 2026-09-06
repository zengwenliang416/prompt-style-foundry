<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import { useTemplateRef, watch } from 'vue';

/**
 * Responsive shell per DESIGN.md §3: sidebar navigation at ≥1024px, top-bar
 * navigation below. Links are native anchors (keyboard path for free); the
 * skip link jumps straight to main content. Active state uses aria-current
 * (exact match) rather than the prefix-matched active class. After every
 * navigation the main region receives focus so keyboard and screen-reader
 * users land on the new page.
 */
const navItems = [
  { to: '/', label: '总览' },
  { to: '/discover', label: '模板发现' },
  { to: '/studio', label: '生成工作台' },
  { to: '/workspace', label: '我的工作区' },
  { to: '/guide', label: '使用指南' },
];

const route = useRoute();
const mainEl = useTemplateRef<HTMLElement>('mainEl');

watch(
  () => route.fullPath,
  async () => {
    await Promise.resolve();
    mainEl.value?.focus({ preventScroll: false });
  },
);
</script>

<template>
  <div class="shell">
    <a class="shell__skip" href="#main-content">跳到主要内容</a>
    <header class="shell__header">
      <RouterLink to="/" class="shell__brand">
        <span class="shell__brand-name">一图万式</span>
        <span class="shell__brand-badge">设计概念</span>
      </RouterLink>
      <nav class="shell__nav shell__nav--top" aria-label="主导航">
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="shell__nav-link">
          {{ item.label }}
        </RouterLink>
      </nav>
    </header>
    <div class="shell__body">
      <aside class="shell__sidebar">
        <nav class="shell__nav shell__nav--side" aria-label="主导航">
          <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="shell__nav-link">
            {{ item.label }}
          </RouterLink>
        </nav>
      </aside>
      <main id="main-content" ref="mainEl" class="shell__main" tabindex="-1">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.shell__skip {
  position: absolute;
  left: -9999px;
  top: 0;
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-2) var(--space-4);
  z-index: 200;
}

.shell__skip:focus {
  left: var(--space-2);
  top: var(--space-2);
}

.shell__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
}

.shell__brand {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  text-decoration: none;
  color: var(--color-ink);
}

.shell__brand-name {
  font-family: var(--font-heading);
  font-size: 1.125rem;
}

.shell__brand-badge {
  font-size: 0.6875rem;
  color: var(--color-on-amber);
  background: var(--color-accent-amber);
  border-radius: 999px;
  padding: 0 var(--space-2);
}

.shell__nav {
  display: flex;
  gap: var(--space-2);
}

.shell__nav--top {
  flex-wrap: wrap;
}

.shell__nav-link {
  text-decoration: none;
  color: var(--color-ink-secondary);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
}

.shell__nav-link:hover {
  color: var(--color-ink);
}

.shell__nav-link[aria-current='page'] {
  color: var(--color-accent-teal);
}

.shell__body {
  display: flex;
  flex: 1;
}

.shell__sidebar {
  display: none;
  width: 220px;
  border-right: 1px solid var(--color-line);
  padding: var(--space-4);
}

.shell__nav--side {
  flex-direction: column;
  position: sticky;
  top: var(--space-4);
}

.shell__main {
  flex: 1;
  padding: var(--space-6) var(--space-4);
  outline: none;
}

@media (min-width: 1024px) {
  .shell__sidebar {
    display: block;
  }

  .shell__nav--top {
    display: none;
  }
}
</style>

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
  { to: '/', label: '总览', icon: '⌂' },
  { to: '/discover', label: '模板发现', icon: '◈' },
  { to: '/studio', label: '生成工作台', icon: '✣' },
  { to: '/workspace', label: '我的工作区', icon: '▱' },
  { to: '/guide', label: '使用指南', icon: '▤' },
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
  <div class="shell" :class="`shell--${String(route.name ?? 'page')}`">
    <a class="shell__skip" href="#main-content">跳到主要内容</a>
    <header class="shell__header">
      <RouterLink to="/" class="shell__brand">
        <span class="shell__brand-mark" aria-hidden="true">图</span>
        <span class="shell__brand-copy">
          <span class="shell__brand-name">一图万式</span>
          <span class="shell__brand-subtitle">OnePic Template Studio</span>
        </span>
        <span class="shell__brand-badge">设计概念</span>
      </RouterLink>
      <nav class="shell__nav shell__nav--top" aria-label="主导航">
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="shell__nav-link">
          <span class="shell__nav-icon" :data-icon="item.icon" aria-hidden="true"></span>
          {{ item.label }}
        </RouterLink>
      </nav>
    </header>
    <div class="shell__body">
      <aside class="shell__sidebar">
        <RouterLink to="/" class="shell__brand shell__brand--side">
          <span class="shell__brand-mark" aria-hidden="true">图</span>
          <span class="shell__brand-copy">
            <span class="shell__brand-name">一图万式</span>
            <span class="shell__brand-subtitle">OnePic Template Studio</span>
          </span>
          <span class="shell__brand-badge">设计概念</span>
        </RouterLink>
        <nav class="shell__nav shell__nav--side" aria-label="主导航">
          <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="shell__nav-link">
            <span class="shell__nav-icon" :data-icon="item.icon" aria-hidden="true"></span>
            {{ item.label }}
          </RouterLink>
        </nav>
        <div class="shell__blueprint" aria-hidden="true"></div>
        <p class="shell__privacy">
          ⌾<span>本地优先<br />图片仅在明确生成后发送</span>
        </p>
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
  background: var(--color-bg);
}
.shell__skip {
  position: fixed;
  left: -9999px;
  top: 0;
  z-index: 300;
  padding: 10px 16px;
  color: var(--color-ink);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
}
.shell__skip:focus {
  left: 8px;
  top: 8px;
}
.shell__header {
  display: flex;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--color-line);
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  backdrop-filter: blur(12px);
}
.shell__brand {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  color: var(--color-ink);
  text-decoration: none;
}
.shell__brand-mark {
  display: inline-grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--color-accent-teal);
  color: var(--color-accent-teal);
  font-family: var(--font-heading);
  font-size: 1.45rem;
  line-height: 1;
  box-shadow:
    inset 0 0 0 4px var(--color-bg),
    inset 0 0 0 5px var(--color-line);
}
.shell__brand-copy {
  display: flex;
  flex-direction: column;
  min-width: max-content;
}
.shell__brand-name {
  font-family: var(--font-heading);
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1.15;
}
.shell__brand-subtitle {
  color: var(--color-ink-secondary);
  font-family: Georgia, serif;
  font-size: 0.58rem;
  letter-spacing: 0.02em;
}
.shell__brand-badge {
  justify-self: start;
  padding: 2px 9px;
  color: #9b5b05;
  border: 1px solid color-mix(in srgb, var(--color-accent-amber) 76%, var(--color-line));
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-accent-amber) 8%, var(--color-surface));
  font-family: var(--font-heading);
  font-size: 0.72rem;
  line-height: 1.35;
}
.shell__body {
  display: flex;
  min-height: calc(100vh - 64px);
}
.shell__sidebar {
  display: none;
}
.shell__nav {
  display: flex;
  gap: 6px;
}
.shell__nav--top {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.shell__nav-link {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--color-ink-secondary);
  text-decoration: none;
  transition:
    color 160ms ease,
    background 160ms ease,
    border-color 160ms ease,
    transform 160ms ease;
}
.shell__nav-link:hover {
  color: var(--color-ink);
  border-color: color-mix(in srgb, var(--color-line) 75%, transparent);
  background: color-mix(in srgb, var(--color-surface) 78%, transparent);
}
.shell__nav-link[aria-current='page'] {
  color: var(--color-on-teal);
  border-color: #0b555a;
  background: linear-gradient(135deg, #103f45, #075d64);
  box-shadow: 0 8px 22px rgb(8 61 66 / 14%);
}
.shell__nav-icon {
  display: inline-grid;
  width: 1.45em;
  place-items: center;
  color: currentColor;
  font-family: var(--font-heading);
  font-size: 1.12rem;
  line-height: 1;
}
.shell__nav-icon::before {
  content: attr(data-icon);
}
.shell__main {
  position: relative;
  min-width: 0;
  flex: 1;
  padding: 28px 24px 44px;
  outline: none;
  overflow: clip;
}
.shell__main::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: -72px;
  right: -78px;
  width: 280px;
  height: 240px;
  opacity: 0.22;
  background:
    radial-gradient(
      circle at 50% 50%,
      transparent 0 42px,
      var(--color-line) 43px 44px,
      transparent 45px 70px,
      var(--color-line) 71px 72px,
      transparent 73px
    ),
    linear-gradient(90deg, transparent 49.7%, var(--color-line) 50%, transparent 50.3%),
    linear-gradient(transparent 49.7%, var(--color-line) 50%, transparent 50.3%);
}
.shell__blueprint,
.shell__privacy {
  display: none;
}
@media (min-width: 1024px) {
  .shell__header {
    display: none;
  }
  .shell__body {
    min-height: 100vh;
  }
  .shell__sidebar {
    position: sticky;
    top: 0;
    display: flex;
    width: 232px;
    height: 100vh;
    flex: 0 0 232px;
    flex-direction: column;
    overflow: hidden;
    padding: 28px 16px 20px;
    border-right: 1px solid color-mix(in srgb, var(--color-line) 84%, #9f8250);
    background: color-mix(in srgb, var(--color-bg) 94%, var(--color-surface));
  }
  .shell__brand--side {
    grid-template-columns: 1fr;
    justify-items: center;
    gap: 8px;
    padding: 0 8px 28px;
    text-align: center;
  }
  .shell__brand--side .shell__brand-mark {
    width: 64px;
    height: 64px;
    font-size: 2.15rem;
    box-shadow:
      inset 0 0 0 6px var(--color-bg),
      inset 0 0 0 7px var(--color-line);
  }
  .shell__brand--side .shell__brand-name {
    font-size: 1.9rem;
    letter-spacing: 0.08em;
  }
  .shell__brand--side .shell__brand-subtitle {
    margin-top: 2px;
    color: var(--color-ink);
    font-size: 0.68rem;
  }
  .shell__brand--side .shell__brand-badge {
    justify-self: center;
    margin-top: 5px;
    padding-inline: 12px;
    font-size: 0.78rem;
  }
  .shell__nav--side {
    position: relative;
    z-index: 2;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
  }
  .shell__nav--side::before {
    content: '';
    display: block;
    height: 1px;
    margin: 0 8px 16px;
    background: var(--color-line);
  }
  .shell__nav--side .shell__nav-link {
    min-height: 54px;
    padding: 12px 16px;
    font-family: var(--font-heading);
    font-size: 1rem;
    letter-spacing: 0.03em;
  }
  .shell__nav--side .shell__nav-icon {
    width: 1.65em;
    font-size: 1.45rem;
  }
  .shell__main {
    padding: 34px 38px 40px;
  }
  .shell__blueprint {
    position: absolute;
    left: 22px;
    bottom: 46px;
    display: block;
    width: 188px;
    height: 200px;
    opacity: 0.32;
    background:
      radial-gradient(
        circle at 54% 45%,
        transparent 0 32px,
        #9da8a1 33px 34px,
        transparent 35px 55px,
        #9da8a1 56px 57px,
        transparent 58px
      ),
      linear-gradient(90deg, transparent 49.6%, #9da8a1 50%, transparent 50.4%),
      linear-gradient(transparent 49.6%, #9da8a1 50%, transparent 50.4%);
    transform: rotate(-8deg);
  }
  .shell__blueprint::before,
  .shell__blueprint::after {
    content: '';
    position: absolute;
    border: 1px solid #9da8a1;
  }
  .shell__blueprint::before {
    inset: 70px 28px 28px 32px;
    transform: skew(-8deg);
  }
  .shell__blueprint::after {
    left: 18px;
    right: 18px;
    bottom: 16px;
    height: 1px;
    border-width: 1px 0 0;
  }
  .shell__privacy {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: auto 8px 0;
    color: #214f52;
    font-family: var(--font-heading);
    font-size: 0.72rem;
    line-height: 1.55;
  }
}
@media (min-width: 1440px) {
  .shell__sidebar {
    width: 260px;
    flex-basis: 260px;
    padding-inline: 22px;
  }
  .shell__main {
    padding: 38px 46px 46px;
  }
}
@media (max-width: 767px) {
  .shell__brand-subtitle,
  .shell__brand-badge {
    display: none;
  }
  .shell__header {
    align-items: flex-start;
    flex-direction: column;
  }
  .shell__nav--top {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
  .shell__nav--top .shell__nav-link {
    min-height: 38px;
    justify-content: center;
    padding: 7px 4px;
    font-size: 0.72rem;
  }
  .shell__nav--top .shell__nav-icon {
    display: none;
  }
  .shell__main {
    padding: 22px 16px 88px;
  }
}
</style>

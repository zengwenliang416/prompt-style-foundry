<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <section class="not-found">
    <h1>404 · 页面不存在</h1>
    <p>你访问的地址没有对应页面。可能是链接已过期或输入有误。</p>
    <RouterLink to="/" class="not-found__home">返回总览</RouterLink>
  </section>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: flex-start;
}

.not-found__home {
  color: var(--color-accent-teal);
}
</style>

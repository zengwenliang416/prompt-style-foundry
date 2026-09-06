<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Interactive cards receive hover affordance and are focusable links. */
    interactive?: boolean;
  }>(),
  { interactive: false },
);
</script>

<template>
  <component
    :is="interactive ? 'button' : 'article'"
    class="card"
    :class="{ 'card--interactive': interactive }"
  >
    <slot />
  </component>
</template>

<style scoped>
.card {
  display: block;
  width: 100%;
  text-align: inherit;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  padding: var(--space-4);
}

.card--interactive {
  cursor: pointer;
}

.card--interactive:hover {
  border-color: var(--color-accent-teal);
}
</style>

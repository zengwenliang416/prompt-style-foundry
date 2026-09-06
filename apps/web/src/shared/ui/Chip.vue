<script setup lang="ts">
withDefaults(
  defineProps<{
    selected?: boolean;
  }>(),
  { selected: false },
);

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="chip"
    :class="{ 'chip--selected': selected }"
    :aria-pressed="selected"
    @click="emit('toggle')"
  >
    <slot />
  </button>
</template>

<style scoped>
.chip {
  border: 1px solid var(--color-line);
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}

.chip--selected {
  background: var(--color-accent-teal);
  border-color: var(--color-accent-teal);
  color: var(--color-on-teal);
}
</style>

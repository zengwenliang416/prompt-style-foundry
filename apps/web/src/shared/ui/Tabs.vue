<script setup lang="ts">
import { computed, useId } from 'vue';

export interface TabItem {
  id: string;
  label: string;
}

const props = defineProps<{
  tabs: TabItem[];
  modelValue: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

const listId = useId();

const activeIndex = computed(() =>
  Math.max(
    0,
    props.tabs.findIndex((tab) => tab.id === props.modelValue),
  ),
);

function select(id: string): void {
  emit('update:modelValue', id);
}

function onKeydown(event: KeyboardEvent): void {
  const count = props.tabs.length;
  if (count === 0) {
    return;
  }
  let nextIndex: number | undefined;
  if (event.key === 'ArrowRight') {
    nextIndex = (activeIndex.value + 1) % count;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (activeIndex.value - 1 + count) % count;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = count - 1;
  }
  if (nextIndex !== undefined) {
    event.preventDefault();
    const next = props.tabs[nextIndex];
    if (next) {
      select(next.id);
      // Move focus with the selection (roving tabindex pattern).
      const buttons = document
        .getElementById(listId)
        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[nextIndex]?.focus();
    }
  }
}
</script>

<template>
  <div :id="listId" class="tabs" role="tablist" @keydown="onKeydown">
    <button
      v-for="tab in tabs"
      :id="`${listId}-tab-${tab.id}`"
      :key="tab.id"
      type="button"
      role="tab"
      class="tabs__tab"
      :class="{ 'tabs__tab--active': tab.id === modelValue }"
      :aria-selected="tab.id === modelValue"
      :tabindex="tab.id === modelValue ? 0 : -1"
      @click="select(tab.id)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: inline-flex;
  gap: var(--space-2);
  border-bottom: 1px solid var(--color-line);
}

.tabs__tab {
  border: none;
  background: none;
  padding: var(--space-2) var(--space-3);
  color: var(--color-ink-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tabs__tab--active {
  color: var(--color-accent-teal);
  border-bottom-color: var(--color-accent-teal);
}
</style>

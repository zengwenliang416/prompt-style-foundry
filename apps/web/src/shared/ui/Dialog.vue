<script setup lang="ts">
import { useId, useTemplateRef } from 'vue';

withDefaults(
  defineProps<{
    title: string;
  }>(),
  {},
);

const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const dialogEl = useTemplateRef<HTMLDialogElement>('dialogEl');

function open(): void {
  dialogEl.value?.showModal();
}

function close(): void {
  dialogEl.value?.close();
}

function handleClose(): void {
  emit('close');
}

defineExpose({ open, close });
</script>

<template>
  <!-- Native <dialog> gives focus containment and Esc handling for free. -->
  <dialog ref="dialogEl" class="dialog" :aria-labelledby="titleId" @close="handleClose">
    <header class="dialog__header">
      <h2 :id="titleId" class="dialog__title">{{ title }}</h2>
      <button type="button" class="dialog__close" aria-label="关闭对话框" @click="close">×</button>
    </header>
    <div class="dialog__body">
      <slot />
    </div>
  </dialog>
</template>

<style scoped>
.dialog {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-6);
  max-width: min(32rem, calc(100vw - 2 * var(--space-4)));
}

.dialog::backdrop {
  background: rgba(31, 36, 48, 0.45);
}

.dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.dialog__title {
  margin: 0;
  font-size: 1.125rem;
}

.dialog__close {
  border: none;
  background: none;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: var(--space-1);
}

.dialog__body {
  margin-top: var(--space-3);
}
</style>

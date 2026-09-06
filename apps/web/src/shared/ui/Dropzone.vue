<script setup lang="ts">
import { ref, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Comma-separated input[type=file] accept list; U07 owns strict validation. */
    accept?: string;
    /** Human hint shown inside the zone. */
    hint?: string;
    disabled?: boolean;
  }>(),
  { accept: 'image/*', hint: '拖入或选择一张图片', disabled: false },
);

const emit = defineEmits<{ files: [files: File[]] }>();

const fileInput = ref<HTMLInputElement | undefined>();
const dragOver = ref(false);
const inputId = useId();

function emitFiles(list: FileList | null): void {
  if (list === null || list.length === 0) {
    return;
  }
  emit('files', Array.from(list));
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  if (props.disabled) {
    return;
  }
  emitFiles(event.dataTransfer?.files ?? null);
}

function openPicker(): void {
  fileInput.value?.click();
}
</script>

<template>
  <div
    class="dropzone"
    :class="{ 'dropzone--over': dragOver, 'dropzone--disabled': disabled }"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <input
      :id="inputId"
      ref="fileInput"
      type="file"
      class="dropzone__input"
      :accept="accept"
      :disabled="disabled"
      @change="emitFiles(($event.target as HTMLInputElement).files)"
    />
    <p class="dropzone__hint">{{ hint }}</p>
    <button type="button" class="dropzone__pick" :disabled="disabled" @click="openPicker">
      选择图片
    </button>
  </div>
</template>

<style scoped>
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: var(--space-8) var(--space-4);
  text-align: center;
}

.dropzone--over {
  border-color: var(--color-accent-teal);
  background: color-mix(in srgb, var(--color-accent-teal) 6%, var(--color-surface));
}

.dropzone--disabled {
  opacity: 0.6;
}

/* The input stays in the a11y tree for keyboard users; picking goes through
   the visible button, and the input itself remains focusable/reachable. */
.dropzone__input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.dropzone__hint {
  margin: 0;
  color: var(--color-ink-secondary);
}

.dropzone__pick {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
}
</style>

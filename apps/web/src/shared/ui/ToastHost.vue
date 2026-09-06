<script setup lang="ts">
import { toastState, dismissToast } from './toast.js';
</script>

<template>
  <div class="toasts" aria-live="polite">
    <!-- aria-live announces toasts without stealing focus; errors are
         additionally exposed with role="alert" (assertive). -->
    <div
      v-for="item in toastState.items"
      :key="item.id"
      class="toast"
      :class="`toast--${item.tone}`"
      :role="item.tone === 'error' ? 'alert' : 'status'"
    >
      <span class="toast__message">{{ item.message }}</span>
      <button
        type="button"
        class="toast__dismiss"
        aria-label="关闭提示"
        @click="dismissToast(item.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  inset-block-end: var(--space-4);
  inset-inline-end: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  z-index: 100;
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  padding: var(--space-3) var(--space-4);
  box-shadow: 0 2px 8px rgba(31, 36, 48, 0.12);
}

.toast--success {
  border-color: var(--color-accent-teal);
}

.toast--error {
  border-color: var(--color-danger);
}

.toast__dismiss {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0;
}
</style>

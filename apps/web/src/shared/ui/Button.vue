<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger';
    loading?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit';
  }>(),
  { variant: 'primary', loading: false, disabled: false, type: 'button' },
);
</script>

<template>
  <button
    class="btn"
    :class="`btn--${variant}`"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
  >
    <span v-if="loading" class="btn__spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border-radius: var(--radius-control);
  border: 1px solid transparent;
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.btn--primary {
  background: var(--color-accent-teal);
  color: var(--color-on-teal);
}

.btn--secondary {
  background: var(--color-surface);
  color: var(--color-ink);
  border-color: var(--color-line);
}

.btn--danger {
  background: var(--color-danger);
  color: var(--color-on-danger);
}

.btn__spinner {
  width: 0.9em;
  height: 0.9em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: btn-spin 0.8s linear infinite;
}

@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

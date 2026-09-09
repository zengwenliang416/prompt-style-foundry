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
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 7px 15px;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  font-family: var(--font-heading);
  font-size: 0.88rem;
  transition:
    transform 150ms ease,
    border-color 150ms ease,
    background 150ms ease,
    box-shadow 150ms ease;
}

.btn:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgb(42 37 26 / 10%);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.btn--primary {
  color: var(--color-on-teal);
  border-color: #0b555a;
  background: linear-gradient(135deg, var(--color-teal-deep), #08646a);
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

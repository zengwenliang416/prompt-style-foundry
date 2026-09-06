<script setup lang="ts">
import { useId } from 'vue';

withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    type?: string;
    placeholder?: string;
    error?: string;
    disabled?: boolean;
    autocomplete?: string;
  }>(),
  {
    type: 'text',
    placeholder: undefined,
    error: undefined,
    disabled: false,
    autocomplete: undefined,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const id = useId();
</script>

<template>
  <div class="input">
    <label class="input__label" :for="id">{{ label }}</label>
    <input
      :id="id"
      class="input__field"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${id}-error` : undefined"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <p v-if="error" :id="`${id}-error`" class="input__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.input {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.input__label {
  font-size: 0.875rem;
  color: var(--color-ink);
}

.input__field {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-2) var(--space-3);
}

.input__field:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.input__field[aria-invalid='true'] {
  border-color: var(--color-danger);
}

.input__error {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.8125rem;
}
</style>

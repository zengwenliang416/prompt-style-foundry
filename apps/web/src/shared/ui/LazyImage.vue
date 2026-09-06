<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    src: string;
    alt: string;
    /** Aspect-ratio box so the lazy load does not shift layout. */
    aspectRatio?: string;
  }>(),
  { aspectRatio: '3 / 2' },
);

const emit = defineEmits<{ load: []; error: [] }>();

const failed = ref(false);
const loaded = ref(false);

watch(
  () => props.src,
  () => {
    failed.value = false;
    loaded.value = false;
  },
);

function onError(): void {
  failed.value = true;
  emit('error');
}
</script>

<template>
  <div class="lazy-image" :style="{ aspectRatio }">
    <!-- loading=lazy + decoding=async: previews outside the viewport never
         hit the network until scroll brings them near (U03 acceptance). -->
    <img
      v-if="!failed"
      :src="src"
      :alt="alt"
      loading="lazy"
      decoding="async"
      :class="{ 'lazy-image__img--loaded': loaded }"
      @load="
        loaded = true;
        $emit('load');
      "
      @error="onError"
    />
    <p v-else class="lazy-image__fallback" role="status">预览不可用</p>
  </div>
</template>

<style scoped>
.lazy-image {
  width: 100%;
  overflow: hidden;
  background: var(--color-bg);
  border-radius: var(--radius-control);
  display: flex;
  align-items: center;
  justify-content: center;
}

.lazy-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.lazy-image img.lazy-image__img--loaded {
  opacity: 1;
}

.lazy-image__fallback {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}
</style>

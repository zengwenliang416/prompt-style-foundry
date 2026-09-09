<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    src: string;
    alt: string;
    /** Aspect-ratio box so the lazy load does not shift layout. */
    aspectRatio?: string;
    /** `contain` preserves the whole preview; `cover` fills and may crop. */
    fit?: 'cover' | 'contain';
    /** Update the frame to the loaded image's intrinsic ratio. */
    adaptAspect?: boolean;
  }>(),
  { aspectRatio: '3 / 2', fit: 'cover', adaptAspect: false },
);

const emit = defineEmits<{ load: []; error: [] }>();

const failed = ref(false);
const loaded = ref(false);
const resolvedAspect = ref(props.aspectRatio);

watch(
  () => props.src,
  () => {
    failed.value = false;
    loaded.value = false;
    resolvedAspect.value = props.aspectRatio;
  },
);

function onLoad(event: Event): void {
  const image = event.currentTarget as HTMLImageElement | null;
  if (props.adaptAspect && image !== null && image.naturalWidth > 0 && image.naturalHeight > 0) {
    resolvedAspect.value = `${image.naturalWidth} / ${image.naturalHeight}`;
  }
  loaded.value = true;
  emit('load');
}

function onError(): void {
  failed.value = true;
  emit('error');
}
</script>

<template>
  <div class="lazy-image" :class="`lazy-image--${fit}`" :style="{ aspectRatio: resolvedAspect }">
    <!-- loading=lazy + decoding=async: previews outside the viewport never
         hit the network until scroll brings them near (U03 acceptance). -->
    <img
      v-if="!failed"
      :src="src"
      :alt="alt"
      loading="lazy"
      decoding="async"
      :class="{ 'lazy-image__img--loaded': loaded }"
      @load="onLoad"
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
  object-fit: var(--lazy-image-fit, cover);
  opacity: 0;
  transition: opacity 0.3s ease;
}
.lazy-image--cover {
  --lazy-image-fit: cover;
}

.lazy-image--contain {
  --lazy-image-fit: contain;
  background: color-mix(in srgb, var(--color-bg) 82%, #d8d2c4);
}

.lazy-image--contain img {
  padding: 8px;
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

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { useCatalogStore } from '../../entities/catalog/store.js';
import { LazyImage, Chip, Button, Card } from '../../shared/ui/index.js';
import {
  DEFAULT_QUERY,
  PAGE_SIZE,
  filterTemplates,
  queryFromParams,
  type DiscoverQuery,
} from './filtering.js';

/**
 * Discover page (U04). URL query is the single source of truth for filters so
 * searches are shareable and survive refresh. Blueprint type chips describe
 * the catalog's original blueprint types, not run modes.
 */

const store = useCatalogStore();
const route = useRoute();
const router = useRouter();

const query = ref<DiscoverQuery>(queryFromParams(route.query));
const visibleCount = ref(PAGE_SIZE);

// Catalog load is idempotent and deduped by the store; pages may call it.
void store.load();

watch(
  () => route.query,
  (next) => {
    query.value = queryFromParams(next);
    visibleCount.value = PAGE_SIZE;
  },
);

watch(
  query,
  (next) => {
    const payload: Record<string, string> = {};
    if (next.q !== '') payload['q'] = next.q;
    if (next.category !== '') payload['category'] = next.category;
    if (next.mode !== '') payload['mode'] = next.mode;
    if (next.sort !== 'catalog') payload['sort'] = next.sort;
    const current = route.query;
    const changed =
      queryFromParams(current).q !== next.q ||
      queryFromParams(current).category !== next.category ||
      queryFromParams(current).mode !== next.mode ||
      queryFromParams(current).sort !== next.sort;
    if (changed) {
      void router.replace({ query: payload });
    }
    visibleCount.value = PAGE_SIZE;
  },
  { deep: true },
);

const filtered = computed(() => filterTemplates(store.templates, query.value));
const visible = computed(() => filtered.value.slice(0, visibleCount.value));
const remaining = computed(() => filtered.value.length - visible.value.length);
const hasActiveFilters = computed(
  () => JSON.stringify(query.value) !== JSON.stringify(DEFAULT_QUERY),
);

function clearFilters(): void {
  query.value = { ...DEFAULT_QUERY };
}

function previewSrc(id: string): string | undefined {
  const template = store.templateById(id);
  if (template === undefined) {
    return undefined;
  }
  return template.generatedPreview ?? template.preview;
}
</script>

<template>
  <section class="discover">
    <header class="discover__header">
      <h1>为你的图片，找到下一种表达</h1>
      <div class="discover__tools">
        <input
          v-model="query.q"
          class="discover__search"
          type="search"
          :aria-label="'搜索模板（标题、风格、场景或编号）'"
          placeholder="搜索标题、风格、场景或编号"
        />
        <label class="discover__sort">
          排序
          <select v-model="query.sort" aria-label="排序方式">
            <option value="catalog">默认（目录序）</option>
            <option value="title">标题</option>
            <option value="id">编号</option>
          </select>
        </label>
      </div>
      <fieldset class="discover__group">
        <legend>原始蓝图类型</legend>
        <Chip :selected="query.mode === ''" @toggle="query.mode = ''">全部</Chip>
        <Chip
          v-for="mode in store.catalog?.filters?.blueprintInputModes ?? []"
          :key="mode"
          :selected="query.mode === mode"
          @toggle="query.mode = mode"
        >
          {{ mode === 'text-to-image' ? '文生图蓝图' : '图生图蓝图' }}
        </Chip>
      </fieldset>
      <fieldset class="discover__group">
        <legend>分类</legend>
        <Chip :selected="query.category === ''" @toggle="query.category = ''">全部分类</Chip>
        <Chip
          v-for="category in store.catalog?.filters?.categories ?? []"
          :key="category"
          :selected="query.category === category"
          @toggle="query.category = query.category === category ? '' : category"
        >
          {{ category }}
        </Chip>
      </fieldset>
    </header>

    <div v-if="store.status === 'loading'" role="status">目录加载中……</div>
    <div v-else-if="store.status === 'error'" role="alert" class="discover__state">
      <p>{{ store.error }}</p>
      <Button variant="secondary" @click="() => void store.load()">重试</Button>
    </div>
    <div v-else-if="store.status === 'empty'" role="status" class="discover__state">
      <p>目录为空。</p>
      <Button variant="secondary" @click="() => void store.load()">重新加载</Button>
    </div>
    <template v-else>
      <p class="discover__count" role="status">共 {{ filtered.length }} 个模板</p>
      <div v-if="filtered.length === 0" class="discover__state">
        <p>没有符合条件的结果。</p>
        <Button v-if="hasActiveFilters" variant="secondary" @click="clearFilters">清空筛选</Button>
      </div>
      <div v-else class="discover__grid">
        <Card v-for="template in visible" :key="template.id" class="discover__card">
          <RouterLink :to="`/studio/${template.id}`" class="discover__card-link">
            <LazyImage :src="previewSrc(template.id) ?? ''" :alt="`${template.title} 预览`" />
            <h2 class="discover__card-title">{{ template.title }}</h2>
            <p class="discover__card-meta">
              <span class="discover__card-id">{{ template.id }}</span>
              <span
                class="discover__card-badge"
                :class="`discover__card-badge--${template.blueprintInputMode}`"
              >
                {{ template.blueprintInputMode === 'text-to-image' ? '文生图蓝图' : '图生图蓝图' }}
              </span>
            </p>
            <p class="discover__card-category">{{ template.category }}</p>
            <span class="discover__card-cta">查看模板</span>
          </RouterLink>
        </Card>
      </div>
      <p v-if="remaining > 0" class="discover__more">
        <Button variant="secondary" @click="visibleCount += PAGE_SIZE">
          加载更多（还有 {{ remaining }} 个）
        </Button>
      </p>
    </template>
  </section>
</template>

<style scoped>
.discover {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.discover__header {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.discover__header h1 {
  margin: 0;
}

.discover__tools {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.discover__search {
  flex: 1;
  min-width: 16rem;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-2) var(--space-3);
}

.discover__sort select {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-2) var(--space-3);
}

.discover__group {
  border: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.discover__group legend {
  float: left;
  padding: 0;
  margin-inline-end: var(--space-2);
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.discover__count {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.discover__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-6);
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-card);
}

.discover__grid {
  columns: 4;
  column-gap: var(--space-3);
}

@media (max-width: 1280px) {
  .discover__grid {
    columns: 3;
  }
}

@media (max-width: 1024px) {
  .discover__grid {
    columns: 2;
  }
}

@media (max-width: 640px) {
  .discover__grid {
    columns: 1;
  }
}

.discover__card {
  margin-block-end: var(--space-3);
  break-inside: avoid;
}

.discover__card-link {
  display: block;
  text-decoration: none;
  color: inherit;
}

.discover__card-title {
  margin: var(--space-2) 0 0;
  font-size: 1rem;
}

.discover__card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: var(--space-1) 0 0;
}

.discover__card-id {
  color: var(--color-ink-secondary);
  font-size: 0.75rem;
}

.discover__card-badge {
  font-size: 0.6875rem;
  border-radius: 999px;
  padding: 0 var(--space-2);
}

.discover__card-badge--text-to-image {
  background: var(--color-accent-amber);
  color: var(--color-on-amber);
}

.discover__card-badge--image-to-image {
  background: var(--color-accent-teal);
  color: var(--color-on-teal);
}

.discover__card-category {
  margin: var(--space-1) 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.discover__card-cta {
  display: inline-block;
  margin-block-start: var(--space-2);
  color: var(--color-accent-teal);
  font-size: 0.875rem;
}

.discover__more {
  text-align: center;
}
</style>

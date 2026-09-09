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
      <p class="discover__promise">✧ 公开模板均支持单图使用</p>
      <fieldset class="discover__modes discover__group">
        <legend>原始蓝图类型</legend>
        <Chip :selected="query.mode === ''" @toggle="query.mode = ''"
          >全部 {{ store.templates.length }}</Chip
        >
        <Chip
          v-for="mode in store.catalog?.filters?.blueprintInputModes ?? []"
          :key="mode"
          :selected="query.mode === mode"
          @toggle="query.mode = mode"
        >
          {{ mode === 'text-to-image' ? '文生图蓝图' : '图生图蓝图' }}
        </Chip>
      </fieldset>
    </header>

    <div class="discover__body">
      <aside class="discover__categories" aria-label="模板分类">
        <h2>模板分类</h2>
        <Chip :selected="query.category === ''" @toggle="query.category = ''">全部分类</Chip>
        <Chip
          v-for="category in store.catalog?.filters?.categories ?? []"
          :key="category"
          :selected="query.category === category"
          @toggle="query.category = query.category === category ? '' : category"
        >
          {{ category }}
        </Chip>
        <div class="discover__compass" aria-hidden="true"></div>
      </aside>

      <div class="discover__catalog">
        <div class="discover__tools">
          <label class="discover__search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              v-model="query.q"
              class="discover__search"
              type="search"
              :aria-label="'搜索模板（标题、风格、场景或编号）'"
              placeholder="搜索标题、风格、场景或编号"
            />
          </label>
          <label class="discover__sort">
            <span>排序</span>
            <select v-model="query.sort" aria-label="排序方式">
              <option value="catalog">默认（目录序）</option>
              <option value="title">标题</option>
              <option value="id">编号</option>
            </select>
          </label>
          <span class="discover__examples">▦ 已生成示例</span>
        </div>

        <div v-if="store.status === 'loading'" role="status" class="discover__state">
          目录加载中……
        </div>
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
            <Button v-if="hasActiveFilters" variant="secondary" @click="clearFilters"
              >清空筛选</Button
            >
          </div>
          <div v-else class="discover__grid">
            <Card v-for="template in visible" :key="template.id" class="discover__card">
              <RouterLink :to="`/studio/${template.id}`" class="discover__card-link">
                <LazyImage
                  :src="previewSrc(template.id) ?? ''"
                  :alt="`${template.title} 预览`"
                  aspect-ratio="1 / 1"
                  fit="contain"
                  adapt-aspect
                />
                <div class="discover__card-body">
                  <h2 class="discover__card-title">{{ template.title }}</h2>
                  <p class="discover__card-meta-line">
                    <span>案例编号 </span><span class="discover__card-id">{{ template.id }}</span>
                  </p>
                  <span
                    class="discover__card-badge"
                    :class="`discover__card-badge--${template.blueprintInputMode}`"
                  >
                    {{
                      template.blueprintInputMode === 'text-to-image' ? '文生图蓝图' : '图生图蓝图'
                    }}
                  </span>
                  <div class="discover__card-footer">
                    <span>☆ 收藏</span>
                    <span class="discover__card-cta">查看模板</span>
                  </div>
                </div>
              </RouterLink>
            </Card>
          </div>
          <p v-if="remaining > 0" class="discover__more">
            <Button variant="secondary" @click="visibleCount += PAGE_SIZE">
              加载更多（还有 {{ remaining }} 个）
            </Button>
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.discover {
  min-width: 0;
}
.discover__header {
  padding: 8px 8px 22px;
}
.discover__header h1 {
  margin: 0;
  color: #11171b;
  font-size: clamp(2.35rem, 4vw, 4.2rem);
  letter-spacing: 0.045em;
}
.discover__header h1::after {
  content: '';
  display: block;
  width: 110px;
  height: 2px;
  margin-top: 7px;
  background: var(--color-accent-amber);
}
.discover__promise {
  margin: 10px 0 16px;
  color: var(--color-ink-secondary);
  font-family: var(--font-heading);
}
.discover__modes {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  border: 0;
}
.discover__modes legend {
  float: left;
  margin-right: 12px;
  padding: 0;
  color: var(--color-ink);
  font-family: var(--font-heading);
  font-weight: 700;
}
.discover__body {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 22px;
}
.discover__categories {
  position: relative;
  min-height: 610px;
  padding: 0;
  border: 1px solid var(--color-line);
  border-radius: 9px;
  overflow: hidden;
  background: color-mix(in srgb, var(--color-surface) 60%, transparent);
}
.discover__categories h2 {
  margin: 0 0 6px;
  padding: 18px 20px;
  color: white;
  background: linear-gradient(135deg, #0c4a50, #075f65);
  font-size: 1rem;
  letter-spacing: 0.06em;
}
.discover__categories :deep(.chip) {
  display: flex;
  width: calc(100% - 20px);
  min-height: 42px;
  align-items: center;
  justify-content: flex-start;
  margin: 5px 10px;
  padding: 8px 14px;
  border-color: transparent;
  border-radius: 5px;
  background: transparent;
  font-family: var(--font-heading);
  text-align: left;
}
.discover__categories :deep(.chip[aria-pressed='true']) {
  color: white;
  background: var(--color-teal-deep);
}
.discover__compass {
  position: absolute;
  left: 44px;
  bottom: 36px;
  width: 104px;
  height: 104px;
  opacity: 0.28;
  border: 1px solid #8f9d96;
  border-radius: 50%;
  background:
    linear-gradient(45deg, transparent 49.5%, #8f9d96 50%, transparent 50.5%),
    linear-gradient(-45deg, transparent 49.5%, #8f9d96 50%, transparent 50.5%),
    radial-gradient(circle, transparent 0 26px, #8f9d96 27px, transparent 28px);
}
.discover__catalog {
  min-width: 0;
}
.discover__tools {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}
.discover__search-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
}
.discover__search-wrap > span {
  color: var(--color-ink);
  font-size: 1.35rem;
}
.discover__search {
  min-width: 0;
  width: 100%;
  padding: 8px 0;
  border: 0;
  outline: 0;
  color: var(--color-ink);
  background: transparent;
}
.discover__sort {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 6px;
  padding-left: 10px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-surface);
}
.discover__sort span {
  font-family: var(--font-heading);
}
.discover__sort select {
  height: 42px;
  border: 0;
  border-left: 1px solid var(--color-line);
  background: transparent;
  padding: 0 10px;
}
.discover__examples {
  min-height: 44px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-surface);
  font-family: var(--font-heading);
  white-space: nowrap;
}
.discover__count {
  margin: 0 0 10px;
  color: var(--color-ink-secondary);
  font-size: 0.82rem;
}
.discover__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.discover__card {
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border-radius: 8px;
  box-shadow: 0 5px 15px rgb(71 52 25 / 10%);
}
.discover__card-link {
  display: block;
  color: inherit;
  text-decoration: none;
}
.discover__card-link :deep(.lazy-image) {
  border-radius: 0;
}
.discover__card-body {
  padding: 9px 11px 10px;
}
.discover__card-title {
  min-height: 2.4em;
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.35;
}
.discover__card-meta-line {
  margin: 3px 0 6px;
  color: var(--color-ink-secondary);
  font-size: 0.65rem;
}
.discover__card-badge {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.62rem;
}
.discover__card-badge--text-to-image {
  color: #9b620b;
  background: #fbf2de;
}
.discover__card-badge--image-to-image {
  color: #0a6669;
  background: #e8f3ef;
}
.discover__card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  color: var(--color-ink-secondary);
  font-size: 0.72rem;
}
.discover__card-cta {
  padding: 4px 9px;
  color: white;
  border-radius: 4px;
  background: var(--color-teal-deep);
  font-family: var(--font-heading);
}
.discover__state {
  padding: 24px;
  border: 1px dashed var(--color-line);
  border-radius: 8px;
}
.discover__more {
  text-align: center;
}
@media (max-width: 1380px) {
  .discover__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 1050px) {
  .discover__body {
    grid-template-columns: 1fr;
  }
  .discover__categories {
    display: flex;
    min-height: auto;
    flex-wrap: wrap;
    padding: 8px;
  }
  .discover__categories h2 {
    width: 100%;
    border-radius: 6px;
  }
  .discover__categories :deep(.chip) {
    width: auto;
  }
  .discover__compass {
    display: none;
  }
  .discover__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .discover__tools {
    grid-template-columns: 1fr;
  }
  .discover__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 500px) {
  .discover__header h1 {
    font-size: 2rem;
  }
  .discover__grid {
    grid-template-columns: 1fr;
  }
}
</style>

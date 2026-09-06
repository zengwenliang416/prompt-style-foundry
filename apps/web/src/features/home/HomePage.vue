<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { useCatalogStore } from '../../entities/catalog/store.js';
import {
  emptyRecord,
  readLocal,
  type LocalStoreStatus,
} from '../../shared/platform/local-store.js';
import { Button, Card, LazyImage } from '../../shared/ui/index.js';

/**
 * Overview page (U06). Statistics come from the loaded catalog only; the
 * local sections (favorites, recent views) read browser-local state and
 * degrade honestly when storage is unavailable or empty. No service status,
 * online counts, or task numbers are ever faked while no generation service
 * is configured.
 */

const store = useCatalogStore();

void store.load();

const localStatus = ref<LocalStoreStatus>({ available: true, corrupted: false });
const localRecord = ref(emptyRecord());

function refreshLocal(): void {
  const result = readLocal();
  localStatus.value = result.status;
  localRecord.value = result.record;
}
refreshLocal();

watch(
  () => store.version,
  () => refreshLocal(),
);

const stats = computed(() => {
  const catalog = store.catalog;
  if (catalog === null || catalog.stats === undefined) {
    return null;
  }
  return {
    total: catalog.stats.total,
    textToImage: catalog.templates.filter((t) => t.blueprintInputMode === 'text-to-image').length,
    imageToImage: catalog.templates.filter((t) => t.blueprintInputMode === 'image-to-image').length,
  };
});

const favoriteCount = computed(() => localRecord.value.favorites.length);

const recentTemplates = computed(() =>
  localRecord.value.recent
    .map((item) => ({ view: item, template: store.templateById(item.id) }))
    .filter(
      (
        entry,
      ): entry is {
        view: { id: string; viewedAt: string };
        template: NonNullable<typeof entry.template>;
      } => entry.template !== undefined,
    )
    .slice(0, 4),
);

const previewSrc = (id: string): string | undefined => {
  const template = store.templateById(id);
  if (template === undefined) {
    return undefined;
  }
  return template.generatedPreview ?? template.preview;
};

// Deterministic four-template glance: first case blueprints that ship a
// preview. This is a catalog slice, not a personalized "recommendation".
const glanceTemplates = computed(() =>
  store.templates.filter((t) => t.kind === 'case').slice(0, 4),
);
</script>

<template>
  <section class="home">
    <div class="home__hero">
      <div>
        <h1>一张图，开启更多视觉可能</h1>
        <p class="home__hero-sub">
          隐私优先 · 无需登录：图片仅在点击生成后发送至你自己配置的接口。
        </p>
        <div class="home__steps">
          <span>01 选模板</span>
          <span>02 上传一张图</span>
          <span>03 确认生成</span>
        </div>
        <RouterLink to="/discover" class="home__cta">开始选模板</RouterLink>
      </div>
      <p v-if="store.status === 'loading'" role="status" class="home__status">目录加载中……</p>
      <div v-else-if="store.status === 'error'" role="alert" class="home__state">
        <p>{{ store.error }}</p>
        <Button variant="secondary" @click="() => void store.load()">重试</Button>
      </div>
      <div v-else-if="stats !== null" class="home__stats">
        <Card class="home__stat">
          <span class="home__stat-value">{{ stats.total }}</span>
          <span class="home__stat-label">全部模板</span>
        </Card>
        <Card class="home__stat">
          <span class="home__stat-value">{{ stats.textToImage }}</span>
          <span class="home__stat-label">文生图蓝图</span>
        </Card>
        <Card class="home__stat">
          <span class="home__stat-value">{{ stats.imageToImage }}</span>
          <span class="home__stat-label">图生图蓝图</span>
        </Card>
        <Card class="home__stat">
          <span class="home__stat-value">{{ favoriteCount }}</span>
          <span class="home__stat-label">本地收藏</span>
        </Card>
      </div>
    </div>

    <p v-if="!localStatus.available" role="status" class="home__warning">
      本地存储不可用（隐私模式或权限受限）：收藏与最近查看在本机无法保存。
    </p>
    <p v-else-if="localStatus.corrupted" role="status" class="home__warning">
      本地记录格式无法识别，已按空记录处理；可在「我的工作区」重新导入。
    </p>

    <p class="home__service-line" role="status">
      本地模式：未连接生成服务。配置接口后才会出现上传与生成入口。
    </p>

    <section aria-label="最近查看">
      <h2 class="home__section-title">最近查看</h2>
      <p v-if="recentTemplates.length === 0" class="home__empty">
        暂无最近查看的模板；浏览模板后会显示在这里（仅保存在本机）。
      </p>
      <div v-else class="home__recent">
        <Card v-for="entry in recentTemplates" :key="entry.view.id" interactive>
          <RouterLink :to="`/studio/${entry.view.id}`" class="home__recent-link">
            <LazyImage
              :src="previewSrc(entry.view.id) ?? ''"
              :alt="`${entry.template.title} 预览`"
            />
            <span class="home__recent-title">{{ entry.template.title }}</span>
            <span class="home__recent-id">{{ entry.view.id }}</span>
          </RouterLink>
        </Card>
      </div>
    </section>

    <section aria-label="模板速览">
      <h2 class="home__section-title">模板速览</h2>
      <div v-if="store.status === 'ready' && glanceTemplates.length > 0" class="home__recent">
        <Card v-for="template in glanceTemplates" :key="template.id" interactive>
          <RouterLink :to="`/studio/${template.id}`" class="home__recent-link">
            <LazyImage :src="previewSrc(template.id) ?? ''" :alt="`${template.title} 预览`" />
            <span class="home__recent-title">{{ template.title }}</span>
            <span class="home__recent-id">{{ template.id }}</span>
          </RouterLink>
        </Card>
      </div>
      <p v-else-if="store.status === 'ready'" class="home__empty">目录为空。</p>
    </section>
  </section>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.home__hero h1 {
  margin: 0 0 var(--space-2);
}

.home__hero-sub {
  margin: 0 0 var(--space-3);
  color: var(--color-ink-secondary);
}

.home__steps {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
  color: var(--color-ink);
  margin-block-end: var(--space-3);
}

.home__cta {
  display: inline-block;
  background: var(--color-accent-teal);
  color: var(--color-on-teal);
  border-radius: var(--radius-control);
  padding: var(--space-2) var(--space-4);
  text-decoration: none;
}

.home__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin-block-start: var(--space-4);
}

@media (max-width: 768px) {
  .home__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.home__stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
}

.home__stat-value {
  font-family: var(--font-heading);
  font-size: 1.75rem;
}

.home__stat-label {
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.home__status,
.home__empty {
  color: var(--color-ink-secondary);
}

.home__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-card);
  padding: var(--space-4);
}

.home__warning {
  margin: 0;
  border: 1px solid var(--color-accent-amber);
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-accent-amber) 10%, var(--color-surface));
  color: var(--color-ink);
  padding: var(--space-3) var(--space-4);
  font-size: 0.875rem;
}

.home__service-line {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.home__section-title {
  margin: 0 0 var(--space-3);
  font-size: 1.125rem;
}

.home__recent {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (max-width: 1024px) {
  .home__recent {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .home__recent {
    grid-template-columns: 1fr;
  }
}

.home__recent-link {
  display: block;
  text-decoration: none;
  color: inherit;
}

.home__recent-title {
  display: block;
  margin-block-start: var(--space-2);
  font-size: 0.9375rem;
}

.home__recent-id {
  display: block;
  color: var(--color-ink-secondary);
  font-size: 0.75rem;
}
</style>

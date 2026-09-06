<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { useCatalogStore } from '../../entities/catalog/store.js';
import {
  deleteCollection,
  createCollection,
  mergeImport,
  readLocal,
  toggleFavorite,
  writeLocal,
  type LocalRecord,
  type LocalStoreStatus,
} from '../../shared/platform/local-store.js';
import { downloadTextFile } from '../../shared/platform/download.js';
import { pushToast, Button, Card, LazyImage, Input } from '../../shared/ui/index.js';

/**
 * Workspace page (U10): local favorites, recent views, generation records,
 * and collections — all browser-local. Import is validated and merged
 * before any write; export is a plain record download that can never
 * contain the BYOK key (which lives in a separate storage slot the export
 * path never reads).
 */

const store = useCatalogStore();
void store.load();

const local = ref<{ record: LocalRecord; status: LocalStoreStatus }>({
  record: { schemaVersion: 1, favorites: [], recent: [], collections: [] },
  status: { available: true, corrupted: false },
});
const storageAvailable = ref(true);

function refresh(): void {
  const result = readLocal();
  local.value = result;
  storageAvailable.value = result.status.available;
}
refresh();

watch(
  () => store.version,
  () => refresh(),
);

const favoriteTemplates = computed(() =>
  local.value.record.favorites
    .map((id) => store.templateById(id))
    .filter((template) => template !== undefined),
);

const recentTemplates = computed(() =>
  local.value.record.recent
    .map((view) => ({ view, template: store.templateById(view.id) }))
    .filter(
      (
        entry,
      ): entry is {
        view: { id: string; viewedAt: string };
        template: NonNullable<ReturnType<typeof store.templateById>>;
      } => entry.template !== undefined,
    ),
);

const previewSrc = (id: string): string => {
  const template = store.templateById(id);
  if (template === undefined) {
    return '';
  }
  return template.generatedPreview ?? template.preview;
};

function unfavorite(id: string): void {
  toggleFavorite(id);
  refresh();
}

const newCollectionName = ref('');
function addCollection(): void {
  const { collection } = createCollection(newCollectionName.value);
  if (collection === null) {
    pushToast('集合名称不能为空', 'error');
    return;
  }
  if (!storageAvailable.value) {
    pushToast('本地存储不可用，集合未能保存', 'error');
  }
  newCollectionName.value = '';
  refresh();
}

function removeCollection(id: string): void {
  deleteCollection(id);
  refresh();
}

const importInput = ref<HTMLInputElement | undefined>();

function onImportFile(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file === undefined) {
    return;
  }
  void file.text().then((text) => {
    const result = mergeImport(text);
    if (!result.ok) {
      pushToast(
        result.error === 'bad-json'
          ? '导入失败：文件不是有效 JSON'
          : '导入失败：记录格式或 schema 版本不符',
        'error',
      );
      return;
    }
    const status: LocalStoreStatus = writeLocal(result.record);
    if (!status.available) {
      pushToast('本地存储不可用，导入未能保存', 'error');
      return;
    }
    pushToast(
      `导入完成：收藏 ${result.merged.favorites} 条新增，最近 ${result.merged.recent} 条，集合 ${result.merged.collections} 个`,
      'success',
    );
    refresh();
  });
  target.value = '';
}

function exportRecord(): void {
  const exported = {
    schemaVersion: 1,
    favorites: local.value.record.favorites,
    recent: local.value.record.recent,
    collections: local.value.record.collections,
  };
  const filename = `onepic-local-record-${new Date().toISOString().slice(0, 10)}.json`;
  downloadTextFile(filename, JSON.stringify(exported, null, 2));
  pushToast(`已导出 ${filename}（不含密钥）`, 'success');
}

function pickImport(): void {
  importInput.value?.click();
}
</script>

<template>
  <section class="workspace">
    <header class="workspace__header">
      <div>
        <h1>我的工作区</h1>
        <p class="workspace__sub">收藏与记录，仅保存在当前浏览器。</p>
      </div>
      <div class="workspace__toolbar">
        <Button variant="secondary" @click="exportRecord">导出本地记录</Button>
        <Button variant="secondary" @click="pickImport">导入记录</Button>
        <input
          ref="importInput"
          type="file"
          accept="application/json,.json"
          class="workspace__import-input"
          aria-label="选择要导入的记录 JSON 文件"
          @change="onImportFile"
        />
      </div>
    </header>

    <p v-if="!storageAvailable" role="alert" class="workspace__warning">
      本地存储不可用：收藏、集合与导入的记录无法保存。
    </p>
    <p v-else-if="local.status.corrupted" role="status" class="workspace__warning">
      原本地记录无法识别，已按空记录处理；可重新导入有效备份。
    </p>

    <p class="workspace__privacy" role="status">
      清理浏览器数据可能移除这里的记录；导出文件是唯一的本机备份方式。
    </p>

    <section aria-label="本地收藏">
      <h2 class="workspace__title">本地收藏（{{ favoriteTemplates.length }}）</h2>
      <p v-if="favoriteTemplates.length === 0" class="workspace__empty">
        暂无本地收藏；在模板详情页点击收藏即可加入。
      </p>
      <div v-else class="workspace__grid">
        <Card v-for="template in favoriteTemplates" :key="template.id" interactive>
          <RouterLink :to="`/studio/${template.id}`" class="workspace__link">
            <LazyImage :src="previewSrc(template.id)" :alt="`${template.title} 预览`" />
            <span class="workspace__item-title">{{ template.title }}</span>
            <span class="workspace__item-id">{{ template.id }}</span>
          </RouterLink>
          <Button variant="secondary" class="workspace__remove" @click="unfavorite(template.id)">
            取消收藏
          </Button>
        </Card>
      </div>
    </section>

    <section aria-label="最近查看">
      <h2 class="workspace__title">最近查看</h2>
      <p v-if="recentTemplates.length === 0" class="workspace__empty">暂无最近查看。</p>
      <ul v-else class="workspace__recent">
        <li v-for="entry in recentTemplates" :key="entry.view.id">
          <RouterLink :to="`/studio/${entry.view.id}`">{{ entry.template.title }}</RouterLink>
          <span class="workspace__recent-time">{{
            entry.view.viewedAt.slice(0, 19).replace('T', ' ')
          }}</span>
        </li>
      </ul>
    </section>

    <section aria-label="生成记录">
      <h2 class="workspace__title">生成记录</h2>
      <p class="workspace__empty">
        还没有本地生成记录。生成功能联调交付后，成功与失败记录会显示在这里。
      </p>
    </section>

    <section aria-label="本地集合">
      <h2 class="workspace__title">本地集合（{{ local.record.collections.length }}）</h2>
      <div class="workspace__collection-form">
        <Input v-model="newCollectionName" label="新集合名称" placeholder="例如：产品图灵感" />
        <Button variant="secondary" @click="addCollection">创建集合</Button>
      </div>
      <p v-if="local.record.collections.length === 0" class="workspace__empty">暂无本地集合。</p>
      <ul v-else class="workspace__collection-list">
        <li v-for="collection in local.record.collections" :key="collection.id">
          <span>{{ collection.name }}</span>
          <span class="workspace__collection-count"
            >{{ collection.templateIds.length }} 个模板</span
          >
          <Button variant="secondary" @click="removeCollection(collection.id)">删除</Button>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.workspace__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.workspace__header h1 {
  margin: 0;
}

.workspace__sub {
  margin: var(--space-1) 0 0;
  color: var(--color-ink-secondary);
}

.workspace__toolbar {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.workspace__import-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.workspace__warning {
  margin: 0;
  border: 1px solid var(--color-accent-amber);
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--color-accent-amber) 10%, var(--color-surface));
  padding: var(--space-3) var(--space-4);
  font-size: 0.875rem;
}

.workspace__privacy {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.workspace__title {
  margin: 0 0 var(--space-3);
  font-size: 1.125rem;
}

.workspace__empty {
  margin: 0;
  color: var(--color-ink-secondary);
}

.workspace__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (max-width: 1024px) {
  .workspace__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .workspace__grid {
    grid-template-columns: 1fr;
  }
}

.workspace__link {
  display: block;
  text-decoration: none;
  color: inherit;
}

.workspace__item-title {
  display: block;
  margin-block-start: var(--space-2);
  font-size: 0.9375rem;
}

.workspace__item-id {
  display: block;
  color: var(--color-ink-secondary);
  font-size: 0.75rem;
}

.workspace__remove {
  margin-block-start: var(--space-2);
}

.workspace__recent {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.workspace__recent-time {
  margin-inline-start: var(--space-3);
  color: var(--color-ink-secondary);
  font-size: 0.75rem;
}

.workspace__collection-form {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-block-end: var(--space-3);
  max-width: 24rem;
}

.workspace__collection-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.workspace__collection-list li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.workspace__collection-count {
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
  margin-inline-end: auto;
}
</style>

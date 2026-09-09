<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { useCatalogStore } from '../../entities/catalog/store.js';
import { useSettingsStore } from '../../entities/settings/store.js';
import { createOnePicClient } from '@onepic/client';
import { importRecordToServer, type ServerImportReport } from './import-to-server.js';
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

const settings = useSettingsStore();
const serverImportBusy = ref(false);
const serverImportReport = ref<ServerImportReport | null>(null);

/**
 * W04: explicit local→server import. Managed mode only, user-triggered,
 * whitelist bodies (template ids / collection names) — never the BYOK key
 * or any settings field.
 */
async function importToServer(): Promise<void> {
  if (settings.runMode !== 'managed-generation') {
    pushToast('仅托管模式支持导入到服务器；请在设置中切换运行模式', 'error');
    return;
  }
  if (serverImportBusy.value) {
    return;
  }
  serverImportBusy.value = true;
  serverImportReport.value = null;
  try {
    const client = createOnePicClient({
      baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    });
    const result = await importRecordToServer(client, local.value.record);
    if (!result.ok) {
      if (result.error === 'unauthenticated') {
        pushToast('导入到服务器需要有效登录会话，请先登录', 'error');
      } else if (result.error === 'invalid-record') {
        pushToast('导入失败：本地记录格式或 schema 版本不符', 'error');
      } else {
        pushToast('导入到服务器暂时不可用，请稍后重试', 'error');
      }
      return;
    }
    serverImportReport.value = result.report;
    const r = result.report;
    pushToast(
      `已导入服务器：集合 新 ${r.collectionsNew}/复用 ${r.collectionsExisting}，条目 新 ${r.itemsNew}/跳过 ${r.itemsSkipped}/失败 ${r.itemsFailed}`,
      r.itemsFailed > 0 || r.failures.length > 0 ? 'error' : 'success',
    );
  } finally {
    serverImportBusy.value = false;
  }
}

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
        <Button
          variant="secondary"
          class="workspace__server-import"
          :disabled="serverImportBusy || settings.runMode !== 'managed-generation'"
          :title="
            settings.runMode === 'managed-generation'
              ? '把本地收藏与集合显式导入服务器（不含密钥）'
              : '仅托管模式支持导入到服务器'
          "
          @click="importToServer"
        >
          {{ serverImportBusy ? '正在导入…' : '导入到服务器' }}
        </Button>
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

    <div
      v-if="serverImportReport !== null"
      role="status"
      class="workspace__server-report"
      aria-label="导入到服务器结果"
    >
      <p>
        服务器导入明细：集合新增 {{ serverImportReport.collectionsNew }}、复用
        {{ serverImportReport.collectionsExisting }}；条目新增
        {{ serverImportReport.itemsNew }}、跳过 {{ serverImportReport.itemsSkipped }}、失败
        {{ serverImportReport.itemsFailed }}。
      </p>
      <ul v-if="serverImportReport.failures.length > 0">
        <li v-for="failure in serverImportReport.failures" :key="failure.label">
          {{ failure.label }}：{{ failure.reason }}
        </li>
      </ul>
    </div>

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
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  min-width: 0;
}
.workspace::after {
  content: '';
  position: absolute;
  z-index: -1;
  right: 28px;
  top: 116px;
  width: 156px;
  height: 100px;
  opacity: 0.18;
  border: 2px solid #87968f;
  border-radius: 5px;
  transform: rotate(-6deg);
}
.workspace__header {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 4px 4px 20px;
  border-bottom: 1px solid var(--color-line);
}
.workspace__header h1 {
  margin: 0;
  color: #11171b;
  font-size: clamp(2.35rem, 4vw, 4rem);
  letter-spacing: 0.05em;
}
.workspace__header h1::after {
  content: '';
  display: block;
  width: 88px;
  height: 2px;
  margin-top: 7px;
  background: var(--color-accent-amber);
}
.workspace__sub {
  margin: 8px 0 0;
  color: var(--color-ink-secondary);
  font-family: var(--font-heading);
}
.workspace__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
}
.workspace__import-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.workspace__warning,
.workspace__privacy,
.workspace__server-report {
  grid-column: 1 / -1;
  margin: 0;
  padding: 10px 14px;
  border-radius: 7px;
  font-size: 0.82rem;
}
.workspace__warning {
  border: 1px solid var(--color-accent-amber);
  background: color-mix(in srgb, var(--color-accent-amber) 10%, var(--color-surface));
}
.workspace__privacy {
  color: var(--color-ink-secondary);
  border-left: 3px solid var(--color-accent-teal);
  background: color-mix(in srgb, var(--color-surface) 62%, transparent);
}
.workspace__server-report {
  border: 1px solid var(--color-accent-amber);
}
.workspace__server-report p {
  margin: 0;
}
.workspace__server-report ul {
  margin: 8px 0 0;
  padding-left: 24px;
}
.workspace > section {
  min-width: 0;
  min-height: 180px;
  padding: 18px;
  border: 1px solid var(--color-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-surface) 66%, transparent);
  box-shadow: 0 5px 14px rgb(69 52 28 / 7%);
}
.workspace > section:first-of-type,
.workspace > section:last-of-type {
  grid-column: 1 / -1;
}
.workspace__title {
  margin: 0 0 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-line);
  font-size: 1.08rem;
  letter-spacing: 0.05em;
}
.workspace__title::before {
  content: '✦';
  margin-right: 7px;
  color: var(--color-accent-amber);
}
.workspace__empty {
  display: grid;
  min-height: 90px;
  place-items: center;
  margin: 0;
  color: var(--color-ink-secondary);
  border: 1px dashed color-mix(in srgb, var(--color-line) 75%, transparent);
  border-radius: 7px;
  font-size: 0.84rem;
  text-align: center;
}
.workspace__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.workspace__grid :deep(.card) {
  overflow: hidden;
  padding: 0 0 10px;
  border-radius: 7px;
}
.workspace__link {
  display: block;
  color: inherit;
  text-decoration: none;
}
.workspace__link :deep(.lazy-image) {
  border-radius: 0;
}
.workspace__item-title {
  display: block;
  padding: 8px 10px 0;
  font-family: var(--font-heading);
  font-size: 0.9rem;
}
.workspace__item-id {
  display: block;
  padding: 2px 10px 0;
  color: var(--color-ink-secondary);
  font-size: 0.68rem;
}
.workspace__remove {
  margin: 8px 10px 0;
}
.workspace__recent,
.workspace__collection-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.workspace__recent li,
.workspace__collection-list li {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--color-line) 74%, transparent);
  border-radius: 6px;
  background: var(--color-surface);
}
.workspace__recent-time {
  margin-left: auto;
  color: var(--color-ink-secondary);
  font-size: 0.7rem;
}
.workspace__collection-form {
  display: flex;
  max-width: 32rem;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 12px;
}
.workspace__collection-count {
  margin-left: auto;
  color: var(--color-ink-secondary);
  font-size: 0.78rem;
}
@media (max-width: 900px) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .workspace > section,
  .workspace > section:first-of-type,
  .workspace > section:last-of-type {
    grid-column: 1;
  }
  .workspace__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .workspace__header h1 {
    font-size: 2rem;
  }
  .workspace__toolbar {
    width: 100%;
  }
  .workspace__toolbar :deep(button) {
    flex: 1;
  }
  .workspace__grid {
    grid-template-columns: 1fr;
  }
  .workspace__collection-form {
    align-items: stretch;
    flex-direction: column;
  }
  .workspace__recent li {
    align-items: flex-start;
    flex-direction: column;
  }
  .workspace__recent-time {
    margin-left: 0;
  }
}
</style>

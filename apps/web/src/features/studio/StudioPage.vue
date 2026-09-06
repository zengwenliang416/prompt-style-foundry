<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { useCatalogStore } from '../../entities/catalog/store.js';
import { copyText } from '../../shared/platform/clipboard.js';
import { recordRecentView } from '../../shared/platform/local-store.js';
import { downloadTextFile } from '../../shared/platform/download.js';
import { verifyPromptHash } from '../../shared/platform/hash.js';
import { pushToast } from '../../shared/ui/index.js';
import { Button, Dropzone, LazyImage, Tabs } from '../../shared/ui/index.js';
import { useInputImage } from './useInputImage.js';
import { toggleFavorite, readLocal } from '../../shared/platform/local-store.js';
import SettingsDialog from './SettingsDialog.vue';
import { useSettingsStore } from '../../entities/settings/store.js';

/**
 * Studio page (U05): template detail, source provenance, and prompt
 * inspection. The compiled single-image prompt and the reviewed sample
 * prompt are fetched on demand and verified against the catalog hash
 * before the integrity badge is shown; copy denial is surfaced as an
 * explicit toast, never silently ignored.
 *
 * Generation controls (run mode, upload) arrive with U07/U08.
 */

const route = useRoute();
const store = useCatalogStore();

void store.load();

const templateId = computed(() => {
  const value = route.params['templateId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
});

const template = computed(() =>
  templateId.value === undefined ? undefined : store.templateById(templateId.value),
);

type PromptTab = 'template' | 'sample';
const tabs = [
  { id: 'template', label: '单图模板' },
  { id: 'sample', label: '示例实际提示词' },
] as const;
const activeTab = ref<PromptTab>('template');

const promptText = ref<string | null>(null);
type HashState = 'pending' | 'ok' | 'mismatch' | 'unavailable';
const hashState = ref<HashState>('pending');
let loadSequence = 0;

const isSampleTab = computed(() => activeTab.value === 'sample');
const hasSample = computed(() => store.samplePromptStatus(templateId.value ?? '') !== 'none');

async function loadActivePrompt(): Promise<void> {
  const id = templateId.value;
  if (id === undefined) {
    promptText.value = null;
    hashState.value = 'pending';
    return;
  }
  const sequence = ++loadSequence;
  hashState.value = 'pending';

  try {
    if (isSampleTab.value) {
      const text = await store.loadSamplePromptText(id);
      if (sequence !== loadSequence) return;
      promptText.value = text;
    } else {
      const text = await store.loadPromptText(id);
      if (sequence !== loadSequence) return;
      promptText.value = text;
      const entry = store.templateById(id);
      if (entry === undefined) {
        hashState.value = 'unavailable';
        return;
      }
      try {
        hashState.value = (await verifyPromptHash(text, entry.promptSha256)) ? 'ok' : 'mismatch';
      } catch {
        // WebCrypto unavailable (e.g. insecure context): honest, non-blocking.
        hashState.value = 'unavailable';
      }
    }
  } catch {
    if (sequence !== loadSequence) return;
    promptText.value = null;
    hashState.value = 'pending';
  }
}

// Re-run when the catalog finishes loading so opening the studio before the
// catalog is ready still ends with the prompt displayed.
watch([templateId, isSampleTab, () => store.status], () => void loadActivePrompt(), {
  immediate: true,
});

// Track locally which templates were inspected (U06 overview surface; U10
// extends the local record views). Failures are silent by design: the view
// must not break because storage is unavailable.
watch(
  templateId,
  (id) => {
    if (id !== undefined) {
      recordRecentView(id);
    }
  },
  { immediate: true },
);

const promptStatus = computed(() =>
  isSampleTab.value
    ? store.samplePromptStatus(templateId.value ?? '')
    : store.promptStatus(templateId.value ?? ''),
);

const promptFileName = computed(() => {
  const id = templateId.value ?? 'prompt';
  return isSampleTab.value ? `${id}.sample.txt` : `${id}.txt`;
});

function copyActivePrompt(): void {
  if (promptText.value === null) {
    return;
  }
  copyText(promptText.value)
    .then(() => {
      pushToast('提示词已复制到剪贴板', 'success');
    })
    .catch(() => {
      pushToast('复制失败：浏览器拒绝了剪贴板访问，请手动选择文本复制', 'error');
    });
}

function downloadActivePrompt(): void {
  if (promptText.value === null) {
    return;
  }
  downloadTextFile(promptFileName.value, promptText.value);
  pushToast(`已开始下载 ${promptFileName.value}`, 'success');
}

const sourceLines = computed(() => {
  const source = template.value?.source;
  if (source === null || source === undefined) {
    return [];
  }
  const lines: Array<{ label: string; value: string; href?: string }> = [
    { label: '上游项目', value: source.project },
    { label: '许可', value: source.license },
  ];
  if (source.author !== undefined && source.author !== '') {
    lines.push({ label: '作者署名', value: source.author });
  }
  if (source.galleryUrl !== undefined && source.galleryUrl !== '') {
    lines.push({ label: '来源图册', value: source.galleryUrl, href: source.galleryUrl });
  } else if (source.sourceUrl !== undefined && source.sourceUrl !== '') {
    lines.push({ label: '来源链接', value: source.sourceUrl, href: source.sourceUrl });
  }
  lines.push({ label: '仓库', value: source.repository, href: source.repository });
  return lines;
});

const previewSrc = computed(() => {
  const entry = template.value;
  if (entry === undefined) {
    return '';
  }
  return entry.generatedPreview ?? entry.preview;
});

// Single-image input (U07). Generation controls land with U08; the image
// stays in the browser and is sent nowhere until an explicit generate action
// exists.
const input = useInputImage();
const settings = useSettingsStore();
settings.load();
const settingsOpen = ref(false);
const favorited = ref(false);

function refreshFavorite(): void {
  const id = templateId.value;
  favorited.value = id !== undefined && readLocal().record.favorites.includes(id);
}
watch(templateId, refreshFavorite, { immediate: true });

function onToggleFavorite(): void {
  const id = templateId.value;
  if (id === undefined) {
    return;
  }
  const { status, favorited: now } = toggleFavorite(id);
  favorited.value = now && status.available;
  pushToast(
    status.available ? (now ? '已加入本地收藏' : '已取消收藏') : '本地存储不可用，收藏未能保存',
    status.available ? 'success' : 'error',
  );
}

function onInputFiles(files: FileList | File[]): void {
  input.accept(files);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
</script>

<template>
  <section class="studio">
    <div v-if="templateId === undefined" class="studio__state">
      <h1>生成工作台</h1>
      <p>
        尚未选择模板。先到 <RouterLink to="/discover">模板发现</RouterLink> 选一个模板，再回到这里。
      </p>
    </div>
    <div v-else-if="template === undefined" class="studio__state" role="status">
      <h1>模板不存在</h1>
      <p>目录里没有 {{ templateId }}。可能已从目录移除。</p>
      <RouterLink to="/discover">返回模板发现</RouterLink>
    </div>
    <template v-else>
      <header class="studio__header">
        <div>
          <h1 class="studio__title">{{ template.title }}</h1>
          <p class="studio__meta">
            <span class="studio__id">{{ template.id }}</span>
            <span class="studio__badge" :class="`studio__badge--${template.blueprintInputMode}`">
              {{ template.blueprintInputMode === 'text-to-image' ? '文生图蓝图' : '图生图蓝图' }}
            </span>
            <span class="studio__category">{{ template.category }}</span>
          </p>
          <Button variant="secondary" class="studio__fav" @click="onToggleFavorite">
            {{ favorited ? '★ 已收藏' : '☆ 收藏' }}
          </Button>
        </div>
      </header>

      <div class="studio__columns">
        <div class="studio__preview">
          <LazyImage
            :src="previewSrc"
            :alt="`${template.title} 示例预览`"
            :aspect-ratio="'3 / 2'"
          />
          <p class="studio__preview-note">示例预览由上游示例生成，正式结果以你上传的图片为准。</p>
        </div>

        <aside class="studio__source" aria-label="来源信息">
          <h2 class="studio__panel-title">来源</h2>
          <dl class="studio__source-list">
            <div v-for="line in sourceLines" :key="line.label" class="studio__source-line">
              <dt>{{ line.label }}</dt>
              <dd>
                <a v-if="line.href" :href="line.href" rel="noopener noreferrer" target="_blank">
                  {{ line.value }}
                </a>
                <span v-else>{{ line.value }}</span>
              </dd>
            </div>
          </dl>
          <p class="studio__source-note">
            模板编号与来源信息保证提示词可追溯；许可信息随源档保留。
          </p>
        </aside>
      </div>

      <section class="studio__input" aria-label="输入图">
        <h2 class="studio__panel-title">输入图（恰好一张）</h2>
        <div v-if="input.file.value === null" class="studio__dropzone">
          <Dropzone
            accept="image/jpeg,image/png,image/webp"
            hint="拖入或选择一张参考图（JPEG / PNG / WebP，≤20 MiB）"
            @files="onInputFiles"
          />
        </div>
        <div v-else class="studio__input-preview">
          <img
            :src="input.objectUrl.value ?? ''"
            alt="已选择的输入图预览"
            class="studio__input-img"
          />
          <div class="studio__input-meta">
            <p class="studio__input-name">{{ input.file.value.name }}</p>
            <p class="studio__input-size">{{ formatBytes(input.file.value.size) }}</p>
            <Button variant="secondary" @click="input.remove()">移除图片</Button>
          </div>
        </div>
        <p v-if="input.error.value !== null" class="studio__input-error" role="alert">
          {{ input.error.value }}
        </p>
      </section>

      <section class="studio__prompt" aria-label="提示词检视">
        <Tabs
          :tabs="[...tabs]"
          :model-value="activeTab"
          @update:model-value="activeTab = $event as PromptTab"
        />
        <div v-if="promptStatus === 'loading'" role="status" class="studio__prompt-state">
          提示词加载中……
        </div>
        <div v-else-if="promptStatus === 'error'" role="alert" class="studio__prompt-state">
          <p>提示词加载失败。</p>
          <Button variant="secondary" @click="() => void loadActivePrompt()">重试</Button>
        </div>
        <div v-else-if="isSampleTab && !hasSample" role="status" class="studio__prompt-state">
          该模板没有已审阅的示例生成提示词；单图模板提示词见「单图模板」页签。
        </div>
        <template v-else-if="promptText !== null">
          <div class="studio__prompt-actions">
            <Button variant="secondary" @click="copyActivePrompt">复制提示词</Button>
            <Button variant="secondary" @click="downloadActivePrompt">下载 .txt</Button>
            <span
              v-if="!isSampleTab"
              class="studio__hash"
              :class="hashState === 'mismatch' ? 'studio__hash--bad' : ''"
            >
              <template v-if="hashState === 'ok'">SHA-256 与目录一致 ✓</template>
              <template v-else-if="hashState === 'mismatch'">SHA-256 校验失败 ✗</template>
              <template v-else-if="hashState === 'unavailable'">SHA-256 校验不可用</template>
              <template v-else>校验中……</template>
            </span>
          </div>
          <pre class="studio__prompt-body">{{ promptText }}</pre>
        </template>
      </section>

      <footer class="studio__bar" aria-label="生成操作">
        <span class="studio__bar-aspect">比例：继承参考图</span>
        <span v-if="settings.runMode !== 'catalog-only'" class="studio__bar-mode"
          >运行模式：{{ settings.runMode === 'direct-byok' ? 'BYOK 直连' : '受管生成' }}</span
        >
        <Button variant="secondary" @click="settingsOpen = true">配置接口与隐私</Button>
        <Button disabled :title="'生成动作随受管/直连联调交付（W 阶段）'">生成图片</Button>
      </footer>
      <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
    </template>
  </section>
</template>

<style scoped>
.studio {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.studio__state {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.studio__header h1 {
  margin: 0;
}

.studio__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: var(--space-2) 0 0;
}

.studio__id {
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.studio__badge {
  font-size: 0.6875rem;
  border-radius: 999px;
  padding: 0 var(--space-2);
}

.studio__badge--text-to-image {
  background: var(--color-accent-amber);
  color: var(--color-on-amber);
}

.studio__badge--image-to-image {
  background: var(--color-accent-teal);
  color: var(--color-on-teal);
}

.studio__category {
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.studio__fav {
  margin-inline-start: var(--space-2);
}

.studio__columns {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--space-4);
}

@media (max-width: 768px) {
  .studio__columns {
    grid-template-columns: 1fr;
  }
}

.studio__preview-note {
  margin: var(--space-2) 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.studio__panel-title {
  margin: 0 0 var(--space-2);
  font-size: 1rem;
}

.studio__source {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: var(--space-4);
}

.studio__source-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.studio__source-line {
  display: flex;
  flex-direction: column;
}

.studio__source-line dt {
  color: var(--color-ink-secondary);
  font-size: 0.75rem;
}

.studio__source-line dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.studio__source-line a {
  color: var(--color-accent-teal);
}

.studio__source-note {
  margin: var(--space-3) 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.studio__input {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.studio__input-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: var(--space-3);
}

.studio__input-img {
  width: 10rem;
  height: auto;
  border-radius: var(--radius-control);
}

.studio__input-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}

.studio__input-name {
  margin: 0;
  overflow-wrap: anywhere;
}

.studio__input-size {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.studio__input-error {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.875rem;
}

.studio__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  border-top: 1px solid var(--color-line);
  padding-block-start: var(--space-3);
}

.studio__bar-aspect,
.studio__bar-mode {
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.studio__prompt {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.studio__prompt-state {
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-card);
  padding: var(--space-4);
}

.studio__prompt-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.studio__hash {
  color: var(--color-accent-teal);
  font-size: 0.8125rem;
}

.studio__hash--bad {
  color: var(--color-danger);
}

.studio__prompt-body {
  margin: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 32rem;
  overflow-y: auto;
  font-size: 0.875rem;
}
</style>

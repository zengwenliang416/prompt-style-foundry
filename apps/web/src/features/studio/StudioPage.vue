<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { useCatalogStore } from '../../entities/catalog/store.js';
import { publicAssetUrl } from '../../entities/catalog/public-asset.js';
import { copyText } from '../../shared/platform/clipboard.js';
import { recordRecentView } from '../../shared/platform/local-store.js';
import { downloadTextFile } from '../../shared/platform/download.js';
import { verifyPromptHash } from '../../shared/platform/hash.js';
import { pushToast } from '../../shared/ui/index.js';
import { Button, Dropzone, LazyImage, Tabs } from '../../shared/ui/index.js';
import { useInputImage } from './useInputImage.js';
import { useManagedGeneration, clearInflight } from './useManagedGeneration.js';
import { useByokGeneration } from './useByokGeneration.js';
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
 * Generation controls (W01): managed-generation runs the full
 * upload→precheck→submit→poll→download flow via useManagedGeneration;
 * the in-flight task survives page refresh (localStorage record) and double
 * clicks are idempotent. catalog-only keeps the button disabled honestly,
 * and direct-byok (W05) posts image+prompt straight to the user-configured
 * endpoint via useByokGeneration — never to /api/*, never with the session
 * cookie cross-origin, and never auto-switching modes on failure.
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

const previewSrc = computed(() => {
  const entry = template.value;
  if (entry === undefined) {
    return '';
  }
  return publicAssetUrl(entry.generatedPreview ?? entry.preview);
});

// Single-image input (U07). The image stays in the browser until the user
// explicitly clicks 生成图片; only then does the managed flow upload it.
const input = useInputImage();
const settings = useSettingsStore();
settings.load();
const settingsOpen = ref(false);
const favorited = ref(false);

// Managed generation (W01/W02): the in-flight task is restored after refresh
// so polling resumes without re-uploading; the restore only touches records
// for the template currently on screen. Leaving managed-generation clears
// the inflight record (登出/模式切换清缓存); the server task itself is
// unaffected and stays queryable for its owner.
const managed = useManagedGeneration();
const byok = useByokGeneration();
watch(
  templateId,
  (id) => {
    managed.reset();
    byok.reset();
    if (settings.runMode === 'managed-generation') {
      void managed.restore(id);
    }
  },
  { immediate: true },
);
watch(
  () => settings.runMode,
  (mode, previous) => {
    if (previous === 'managed-generation' && mode !== 'managed-generation') {
      clearInflight();
      managed.reset();
    }
  },
);

const canGenerate = computed(() => {
  if (settings.runMode === 'managed-generation') {
    return input.file.value !== null && template.value !== undefined && !managed.busy.value;
  }
  if (settings.runMode === 'direct-byok') {
    return (
      input.file.value !== null &&
      template.value !== undefined &&
      promptText.value !== null &&
      byok.configured.value &&
      !byok.busy.value
    );
  }
  return false;
});

const generateTitle = computed(() => {
  if (settings.runMode === 'catalog-only') {
    return '目录浏览模式不连接生成服务，可在设置中切换运行模式';
  }
  if (settings.runMode === 'direct-byok') {
    if (!byok.configured.value) {
      return '先在「配置接口与隐私」中填写 BYOK 接口地址与密钥';
    }
    if (promptText.value === null) {
      return '提示词尚未载入完成';
    }
  }
  if (input.file.value === null) {
    return '先上传恰好一张参考图';
  }
  return undefined;
});

const MANAGED_PHASE_LABELS: Record<string, string> = {
  uploading: '上传中……',
  prechecking: '预审中……',
  submitting: '提交任务……',
  polling: '生成中，正在轮询状态……',
};

function onGenerate(): void {
  const file = input.file.value;
  const entry = template.value;
  if (!canGenerate.value || file === null || entry === undefined) {
    return;
  }
  if (settings.runMode === 'direct-byok') {
    // Explicit click only: image + compiled prompt go straight to the
    // user-configured endpoint; nothing touches /api/* (W05).
    void byok.start({ file, prompt: promptText.value ?? '' });
    return;
  }
  void managed.start({ file, templateId: entry.id, promptSha256: entry.promptSha256 });
}

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
          <p class="studio__page-title">生成工作台</p>
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
            fit="contain"
            adapt-aspect
          />
          <p class="studio__preview-note">
            模板示例仅用于展示视觉效果，正式结果以你上传的图片为准。
          </p>
        </div>
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
        <Button
          :disabled="!canGenerate"
          :title="generateTitle"
          class="studio__generate"
          @click="onGenerate"
        >
          {{ managed.busy.value || byok.busy.value ? '生成中……' : '生成图片' }}
        </Button>
      </footer>

      <section
        v-if="settings.runMode === 'direct-byok' && byok.phase.value !== 'idle'"
        class="studio__run"
        aria-label="生成状态"
      >
        <p v-if="byok.busy.value" class="studio__run-status" role="status">
          正在生成，通常需要几十秒…
        </p>
        <p v-if="byok.phase.value === 'succeeded'" class="studio__run-status" role="status">
          生成完成（BYOK 直连，未经服务器）
        </p>
        <p v-if="byok.error.value !== null" class="studio__run-error" role="alert">
          {{ byok.error.value }}
        </p>
        <div v-if="byok.result.value !== null" class="studio__run-result">
          <img :src="byok.result.value.src" alt="BYOK 直连生成结果图" class="studio__run-img" />
          <a
            class="studio__run-download"
            :href="byok.result.value.src"
            :download="`${templateId ?? 'onepic'}-byok.png`"
            >下载结果图</a
          >
        </div>
      </section>

      <section v-else-if="managed.phase.value !== 'idle'" class="studio__run" aria-label="生成状态">
        <p
          v-if="MANAGED_PHASE_LABELS[managed.phase.value] !== undefined"
          class="studio__run-status"
          role="status"
        >
          {{ MANAGED_PHASE_LABELS[managed.phase.value] }}
        </p>
        <p v-if="managed.phase.value === 'cancelled'" class="studio__run-status" role="status">
          任务已取消；未发送的任务不计费。
        </p>
        <div v-if="managed.phase.value === 'unknown'" class="studio__run-unknown" role="alert">
          <p>
            结果未知：provider
            未确认是否已出图，任务不会自动重试或重复提交。刷新本页可继续查看该任务；等待对账处置，或
          </p>
          <Button variant="secondary" @click="managed.dismissUnknown()">清除本地记录</Button>
        </div>
        <p v-if="managed.notice.value !== null" class="studio__run-notice" role="status">
          {{ managed.notice.value }}
        </p>
        <p
          v-if="managed.error.value !== null && managed.phase.value !== 'unknown'"
          class="studio__run-error"
          role="alert"
        >
          {{ managed.error.value }}
          <a v-if="managed.error.value.includes('登录')" href="/api/v1/auth/login">前往登录</a>
        </p>
        <div v-if="managed.result.value !== null" class="studio__run-result">
          <img
            :src="managed.result.value.downloadUrl"
            alt="受管生成结果图"
            class="studio__run-img"
          />
          <p class="studio__run-meta">
            {{ managed.result.value.actualWidth }}×{{ managed.result.value.actualHeight }} ·
            {{ formatBytes(managed.result.value.actualBytes) }} · sha256
            {{ managed.result.value.sha256.slice(0, 12) }}…
          </p>
          <a
            class="studio__run-download"
            :href="managed.result.value.downloadUrl"
            :download="`${managed.result.value.generationId}.png`"
            >下载结果图</a
          >
        </div>
        <Button
          v-if="managed.canCancel.value"
          variant="secondary"
          class="studio__run-cancel"
          @click="() => void managed.cancel()"
        >
          取消任务
        </Button>
      </section>
      <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
    </template>
  </section>
</template>

<style scoped>
.studio {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1fr) minmax(280px, 0.78fr);
  gap: 14px;
  min-width: 0;
  align-items: start;
}
.studio__state {
  grid-column: 1 / -1;
  padding: 28px;
  border: 1px dashed var(--color-line);
  border-radius: 10px;
}
.studio__header {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  min-height: 100px;
  padding: 4px 4px 12px;
  border-bottom: 1px solid var(--color-line);
}
.studio__page-title {
  margin: 0 0 3px;
  color: #11171b;
  font-family: var(--font-heading);
  font-size: clamp(2rem, 3vw, 3.35rem);
  font-weight: 700;
  letter-spacing: 0.06em;
}
.studio__title {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 1rem;
  font-weight: 500;
}
.studio__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 7px 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.76rem;
}
.studio__id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.studio__badge {
  padding: 2px 7px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 0.68rem;
}
.studio__badge--text-to-image {
  color: #9b620b;
  background: #fbf2de;
}
.studio__badge--image-to-image {
  color: #0a6669;
  background: #e8f3ef;
}
.studio__fav {
  margin-top: 9px;
}
.studio__columns,
.studio__input,
.studio__prompt {
  min-width: 0;
  min-height: 540px;
  border: 1px solid var(--color-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-surface) 68%, transparent);
  box-shadow: 0 5px 14px rgb(69 52 28 / 8%);
}
.studio__columns {
  grid-column: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.studio__preview {
  padding: 14px;
  border-bottom: 1px solid var(--color-line);
}
.studio__preview::before {
  content: '模板预览';
  display: block;
  margin-bottom: 10px;
  font-family: var(--font-heading);
  font-size: 1rem;
  font-weight: 700;
}
.studio__preview :deep(.lazy-image) {
  border-radius: 6px;
}
.studio__preview-note {
  margin: 8px 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.72rem;
}
.studio__panel-title {
  margin: 0 0 11px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-line);
  font-size: 1rem;
  letter-spacing: 0.04em;
}
.studio__input {
  grid-column: 2;
  display: flex;
  flex-direction: column;
  padding: 14px;
}
.studio__dropzone {
  display: flex;
  min-height: 418px;
  flex: 1;
}
.studio__dropzone :deep(*) {
  width: 100%;
}
.studio__input-preview {
  display: grid;
  grid-template-rows: minmax(260px, 1fr) auto;
  gap: 12px;
}
.studio__input-img {
  width: 100%;
  max-height: 390px;
  object-fit: contain;
  border: 1px solid var(--color-line);
  border-radius: 7px;
  background: #ece8dd;
}
.studio__input-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.studio__input-name,
.studio__input-size {
  margin: 0;
}
.studio__input-name {
  font-family: var(--font-heading);
}
.studio__input-size {
  color: var(--color-ink-secondary);
  font-size: 0.75rem;
}
.studio__input-error,
.studio__run-error {
  color: var(--color-danger);
}
.studio__prompt {
  grid-column: 3;
  padding: 14px;
  overflow: hidden;
}
.studio__prompt::before {
  content: '生成设置';
  display: block;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-line);
  font-family: var(--font-heading);
  font-weight: 700;
}
.studio__prompt-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}
.studio__hash {
  color: var(--color-accent-teal);
  font-size: 0.68rem;
}
.studio__hash--bad {
  color: var(--color-danger);
}
.studio__prompt-state {
  padding: 18px 4px;
  color: var(--color-ink-secondary);
}
.studio__prompt-body {
  max-height: 354px;
  margin: 0;
  padding: 12px;
  overflow-y: auto;
  border: 1px solid var(--color-line);
  border-radius: 6px;
  background: #f3efe6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.72rem;
  line-height: 1.55;
}
.studio__bar {
  grid-column: 1 / -1;
  display: flex;
  min-height: 68px;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-surface) 80%, transparent);
}
.studio__bar-aspect,
.studio__bar-mode {
  color: var(--color-ink-secondary);
  font-size: 0.78rem;
}
.studio__bar-aspect {
  margin-right: auto;
}
.studio__generate {
  min-width: 150px;
  min-height: 44px;
  background: var(--color-teal-deep);
}
.studio__run {
  grid-column: 1 / -1;
  padding: 16px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-surface);
}
.studio__run-status {
  margin: 0 0 10px;
}
.studio__run-result {
  display: grid;
  gap: 12px;
}
.studio__run-img {
  max-width: min(100%, 720px);
  border-radius: 8px;
}
.studio__run-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 1260px) {
  .studio {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .studio__columns {
    grid-column: 1;
  }
  .studio__input {
    grid-column: 2;
  }
  .studio__prompt {
    grid-column: 1 / -1;
    min-height: auto;
  }
  .studio__prompt-body {
    max-height: 24rem;
  }
}
@media (max-width: 760px) {
  .studio {
    grid-template-columns: 1fr;
  }
  .studio__header,
  .studio__columns,
  .studio__input,
  .studio__prompt,
  .studio__bar,
  .studio__run {
    grid-column: 1;
  }
  .studio__header {
    min-height: auto;
  }
  .studio__columns,
  .studio__input,
  .studio__prompt {
    min-height: auto;
  }
  .studio__dropzone {
    min-height: 280px;
  }
  .studio__bar {
    align-items: stretch;
    flex-direction: column;
  }
  .studio__bar-aspect {
    margin-right: 0;
  }
}
</style>

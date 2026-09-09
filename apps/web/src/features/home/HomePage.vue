<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { useSettingsStore } from '../../entities/settings/store.js';
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

const settings = useSettingsStore();
settings.load();
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

const generationServiceLine = computed(() => {
  if (settings.runMode === 'catalog-only') {
    return '目录浏览：生成已停用；浏览、收藏与复制不依赖生成服务。';
  }
  if (settings.runMode === 'direct-byok') {
    return settings.byokEndpoint !== '' && settings.hasApiKey
      ? 'BYOK 直连：接口与本机密钥已配置；只有点击生成后才会直连该接口。'
      : 'BYOK 直连：尚未完成接口与本机密钥配置，生成入口会提示补齐配置。';
  }
  return '受管生成：需要已部署的 OnePic API 与有效登录会话；可用性以工作台连接结果为准。';
});
</script>

<template>
  <section class="home">
    <div class="home__canvas">
      <div class="home__primary">
        <header class="home__hero">
          <p class="home__kicker">ONE IMAGE · MANY VISUAL SYSTEMS</p>
          <h1>一张图，开启更多视觉可能</h1>
          <p class="home__hero-sub">选择模板，上传一张图片，生成你的视觉作品。</p>
        </header>

        <RouterLink to="/discover" class="home__upload">
          <span class="home__upload-icon" aria-hidden="true">⇧</span>
          <strong>选择一张参考图</strong>
          <span>图片仅在点击生成后，按所选模式发送至对应接口</span>
        </RouterLink>

        <p v-if="store.status === 'loading'" role="status" class="home__status">目录加载中……</p>
        <div v-else-if="store.status === 'error'" role="alert" class="home__state">
          <p>{{ store.error }}</p>
          <Button variant="secondary" @click="() => void store.load()">重试</Button>
        </div>
        <div v-else-if="stats !== null" class="home__stats">
          <Card class="home__stat">
            <span class="home__stat-icon" aria-hidden="true">▦</span>
            <span
              ><strong class="home__stat-value">{{ stats.total }}</strong
              ><small>全部模板</small></span
            >
          </Card>
          <Card class="home__stat">
            <span class="home__stat-icon" aria-hidden="true">▤</span>
            <span
              ><strong class="home__stat-value">{{ stats.textToImage }}</strong
              ><small>文生图蓝图</small></span
            >
          </Card>
          <Card class="home__stat">
            <span class="home__stat-icon" aria-hidden="true">▧</span>
            <span
              ><strong class="home__stat-value">{{ stats.imageToImage }}</strong
              ><small>图生图蓝图</small></span
            >
          </Card>
          <Card class="home__stat">
            <span class="home__stat-icon home__stat-icon--amber" aria-hidden="true">☆</span>
            <span
              ><strong class="home__stat-value">{{ favoriteCount }}</strong
              ><small>本地收藏</small></span
            >
          </Card>
        </div>

        <p v-if="!localStatus.available" role="status" class="home__warning">
          本地存储不可用（隐私模式或权限受限）：收藏与最近查看在本机无法保存。
        </p>
        <p v-else-if="localStatus.corrupted" role="status" class="home__warning">
          本地记录格式无法识别，已按空记录处理；可在「我的工作区」重新导入。
        </p>

        <section class="home__viewed" aria-label="最近查看">
          <div class="home__section-head"><h2>最近查看</h2></div>
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

        <section class="home__recommend" aria-label="模板速览">
          <div class="home__section-head">
            <h2>✦ 推荐模板</h2>
            <RouterLink to="/discover">浏览模板 →</RouterLink>
          </div>
          <div v-if="store.status === 'ready' && glanceTemplates.length > 0" class="home__recent">
            <Card v-for="template in glanceTemplates" :key="template.id" interactive>
              <RouterLink :to="`/studio/${template.id}`" class="home__recent-link">
                <LazyImage :src="previewSrc(template.id) ?? ''" :alt="`${template.title} 预览`" />
                <span class="home__recent-label">推荐模板</span>
                <span class="home__recent-title">{{ template.title }}</span>
                <span class="home__recent-id">{{ template.id }}</span>
              </RouterLink>
            </Card>
          </div>
          <p v-else-if="store.status === 'ready'" class="home__empty">目录为空。</p>
        </section>
      </div>

      <aside class="home__rail" aria-label="使用方式与接口状态">
        <div class="home__rail-panel">
          <h2><span aria-hidden="true">⌁</span> 使用方式</h2>
          <ol>
            <li>
              <span class="home__sr-only">01 选模板</span>
              <span>01</span>
              <div>
                <strong>选模板</strong>
                <p>在模板库中找到合适的蓝图</p>
              </div>
            </li>
            <li>
              <span class="home__sr-only">02 上传一张图</span>
              <span>02</span>
              <div>
                <strong>上传一张图</strong>
                <p>上传参考图作为生成依据</p>
              </div>
            </li>
            <li>
              <span class="home__sr-only">03 确认生成</span>
              <span>03</span>
              <div>
                <strong>确认生成</strong>
                <p>确认设置后发送至所选接口</p>
              </div>
            </li>
          </ol>
        </div>
        <div class="home__rail-status">
          <strong>{{
            settings.runMode === 'catalog-only' ? '接口未配置' : '生成模式已选择'
          }}</strong>
          <p class="home__service-line" role="status">{{ generationServiceLine }}</p>
          <RouterLink to="/studio" class="home__rail-action">⚙ 配置接口</RouterLink>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.home__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.home {
  min-width: 0;
}
.home__canvas {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
}
.home__primary {
  min-width: 0;
}
.home__hero {
  position: relative;
  padding: 10px 0 24px 72px;
}
.home__hero::before,
.home__hero::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 0;
  width: 54px;
  height: 54px;
  border: 1px solid var(--color-accent-teal);
  border-radius: 50%;
}
.home__hero::after {
  inset: 17px auto auto 13px;
  width: 28px;
  height: 17px;
  border-width: 2px 0 0;
  border-radius: 50%;
  box-shadow:
    0 7px 0 -5px var(--color-accent-teal),
    0 13px 0 -5px var(--color-accent-teal);
}
.home__kicker {
  margin: 0 0 6px;
  color: var(--color-accent-amber);
  font-family: Georgia, serif;
  font-size: 0.68rem;
  letter-spacing: 0.14em;
}
.home__hero h1 {
  max-width: 920px;
  margin: 0;
  color: #11171b;
  font-size: clamp(2.45rem, 4vw, 4.6rem);
  letter-spacing: 0.05em;
}
.home__hero-sub {
  margin: 12px 0 0;
  color: var(--color-ink-secondary);
  font-family: var(--font-heading);
  font-size: clamp(1rem, 1.45vw, 1.28rem);
  letter-spacing: 0.08em;
}
.home__upload {
  display: flex;
  min-height: 196px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  border: 1px dashed #b7a47f;
  border-radius: 14px;
  color: var(--color-ink);
  background: color-mix(in srgb, var(--color-surface) 55%, transparent);
  text-decoration: none;
  transition:
    border-color 160ms ease,
    background 160ms ease;
}
.home__upload:hover {
  border-color: var(--color-accent-teal);
  background: color-mix(in srgb, var(--color-surface) 84%, transparent);
}
.home__upload-icon {
  display: grid;
  width: 50px;
  height: 42px;
  place-items: center;
  color: var(--color-teal-deep);
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  font-size: 2rem;
  line-height: 1;
}
.home__upload strong {
  margin-top: 7px;
  font-family: var(--font-heading);
  font-size: 1.35rem;
}
.home__upload > span:last-child {
  color: var(--color-ink-secondary);
  font-size: 0.84rem;
}
.home__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 22px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
}
.home__stat {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 94px;
  padding: 14px 22px;
  border: 0;
  border-right: 1px solid var(--color-line);
  border-radius: 0;
  background: transparent;
}
.home__stat:last-child {
  border-right: 0;
}
.home__stat > span:last-child {
  display: flex;
  flex-direction: column;
}
.home__stat-icon {
  color: var(--color-teal-deep);
  font-family: var(--font-heading);
  font-size: 2.25rem;
}
.home__stat-icon--amber {
  color: #b96d08;
}
.home__stat-value {
  font-family: var(--font-heading);
  font-size: 2rem;
  font-weight: 500;
  line-height: 1;
}
.home__stat small {
  margin-top: 7px;
  color: var(--color-ink-secondary);
  font-family: var(--font-heading);
  font-size: 0.83rem;
}
.home__warning,
.home__status,
.home__empty {
  color: var(--color-ink-secondary);
}
.home__warning {
  margin: 14px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--color-accent-amber);
  border-radius: 8px;
}
.home__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 20px 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-line);
}
.home__section-head h2 {
  margin: 0;
  font-size: 1.08rem;
  letter-spacing: 0.05em;
}
.home__section-head a {
  color: #ad6508;
  font-family: var(--font-heading);
  text-decoration: none;
}
.home__recent {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.home__recent :deep(.card) {
  position: relative;
  overflow: hidden;
  padding: 0;
  border-radius: 9px;
  box-shadow: 0 5px 15px rgb(72 56 30 / 10%);
}
.home__recent-link {
  position: relative;
  display: block;
  color: inherit;
  text-decoration: none;
}
.home__recent-link :deep(.lazy-image) {
  border-radius: 0;
}
.home__recent-label {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 2px 7px;
  color: #352100;
  border: 1px solid #c88721;
  border-radius: 4px;
  background: #f3dba7;
  font-family: var(--font-heading);
  font-size: 0.68rem;
}
.home__recent-title {
  display: block;
  padding: 8px 10px 0;
  font-family: var(--font-heading);
  font-size: 0.9rem;
}
.home__recent-id {
  display: block;
  padding: 1px 10px 9px;
  color: var(--color-ink-secondary);
  font-size: 0.68rem;
}
.home__rail {
  display: none;
}
.home__rail-panel,
.home__rail-status {
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
}
.home__rail-panel {
  padding: 22px 20px;
}
.home__rail-panel h2 {
  margin: 0 0 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-line);
  font-size: 1.15rem;
}
.home__rail-panel ol {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.home__rail-panel li {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 10px;
}
.home__rail-panel li > span {
  color: #8b590d;
  font-family: Georgia, serif;
  font-size: 1rem;
}
.home__rail-panel strong {
  font-family: var(--font-heading);
}
.home__rail-panel p {
  margin: 3px 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.78rem;
  line-height: 1.55;
}
.home__rail-status {
  margin-top: 14px;
  padding: 18px;
}
.home__rail-status > strong {
  color: #72521c;
  font-family: var(--font-heading);
}
.home__service-line {
  margin: 7px 0 14px;
  color: var(--color-ink-secondary);
  font-size: 0.78rem;
  line-height: 1.55;
}
.home__rail-action {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  color: white;
  border-radius: 7px;
  background: linear-gradient(135deg, #0d454c, #075c63);
  font-family: var(--font-heading);
  text-decoration: none;
}
.home__state {
  margin-top: 16px;
  padding: 16px;
  border: 1px dashed var(--color-line);
  border-radius: 10px;
}
.home__state p {
  margin-top: 0;
}
@media (min-width: 1280px) {
  .home__canvas {
    grid-template-columns: minmax(0, 1fr) 250px;
  }
  .home__rail {
    display: block;
  }
}
@media (max-width: 900px) {
  .home__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home__stat:nth-child(2) {
    border-right: 0;
  }
  .home__stat:nth-child(-n + 2) {
    border-bottom: 1px solid var(--color-line);
  }
  .home__recent {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .home__hero {
    padding-left: 0;
  }
  .home__hero::before,
  .home__hero::after,
  .home__kicker {
    display: none;
  }
  .home__hero h1 {
    font-size: 2rem;
  }
  .home__upload {
    min-height: 160px;
    padding: 18px;
    text-align: center;
  }
  .home__stats,
  .home__recent {
    grid-template-columns: 1fr;
  }
  .home__stat {
    border-right: 0;
    border-bottom: 1px solid var(--color-line);
  }
}
</style>

<script setup lang="ts">
/**
 * Guide page (U11). Content mirrors the real protocol (AGENTS §3) and the
 * real run modes (U08 implementation). Forbidden copy per DESIGN §4.5:
 * no "禁止直接图生图"-style bans and no fabricated "零中转" claims — data
 * goes directly to the user-configured endpoint only after an explicit
 * generate action.
 */

const priorities = [
  { order: '1', title: '你上传的图片决定内容', detail: '正文、人物与场景以这张图为准。' },
  { order: '2', title: '模板蓝图决定视觉处理', detail: '构图、配色与风格指令来自模板。' },
  {
    order: '3',
    title: '示例内容不覆盖你的图',
    detail: '模板里的示例主体、品牌与文字不会替换你上传的图片。',
  },
];

const promptStructure = [
  '以 [System / Prompt] 开头',
  '声明只上传一张图、不追问、保持原图比例与方向',
  '包含 BEGIN VISUAL BLUEPRINT / END VISUAL BLUEPRINT 蓝图段',
  '结尾要求只返回成品图',
];

const blueprints = [
  {
    name: '文生图蓝图',
    detail: '按模板文字描述生成新画面；你上传的图仍决定内容主体。',
  },
  {
    name: '图生图蓝图',
    detail: '以你上传的图为基底做视觉化改造，保持内容主体不变。',
  },
];

const modeLabels: Record<string, { label: string; detail: string; available: boolean }> = {
  'catalog-only': {
    label: '目录浏览',
    detail: '浏览、检索与复制提示词；不连接任何生成服务。',
    available: true,
  },
  'direct-byok': {
    label: 'BYOK 直连',
    detail: '点击生成后，图片与提示词直连你自己配置的接口；密钥仅保存在本机浏览器。',
    available: true,
  },
  'managed-generation': {
    label: '受管生成',
    detail: '需要服务端身份与授权配置；未配置时不会开启。',
    available: false,
  },
};

const modeOrder = ['catalog-only', 'direct-byok', 'managed-generation'];
</script>

<template>
  <section class="guide">
    <header class="guide__hero">
      <h1>图片决定内容，蓝图决定风格</h1>
      <p class="guide__flow" role="img" aria-label="流程：上传一张图片，选择视觉蓝图，生成结果">
        上传一张图片 <span aria-hidden="true">＋</span> 选择视觉蓝图
        <span aria-hidden="true">→</span> 生成结果
      </p>
    </header>

    <section aria-label="生效优先级">
      <h2 class="guide__title">生效优先级</h2>
      <ol class="guide__priorities">
        <li v-for="item in priorities" :key="item.order">
          <span class="guide__order">{{ item.order }}</span>
          <div>
            <strong>{{ item.title }}</strong>
            <p>{{ item.detail }}</p>
          </div>
        </li>
      </ol>
    </section>

    <section aria-label="提示词结构">
      <h2 class="guide__title">每份模板提示词的结构</h2>
      <ul class="guide__structure">
        <li v-for="line in promptStructure" :key="line">{{ line }}</li>
      </ul>
      <p class="guide__note">
        渲染模式上，Nano Banana Pro 是可用时的首选，但不是唯一选项；你也可以在设置中选择其他模型。
      </p>
    </section>

    <section aria-label="蓝图类型">
      <h2 class="guide__title">原始蓝图类型</h2>
      <div class="guide__cards">
        <div v-for="item in blueprints" :key="item.name" class="guide__card">
          <strong>{{ item.name }}</strong>
          <p>{{ item.detail }}</p>
        </div>
      </div>
    </section>

    <section aria-label="来源与追溯">
      <h2 class="guide__title">来源与追溯</h2>
      <p class="guide__text">
        每份模板都保留模板编号、作者署名、上游项目链接与 MIT 许可；提示词正文有 SHA-256
        校验值，详情页展示与下载的内容一致。示例预览来自上游示例，正式结果以你上传的图片为准。
      </p>
    </section>

    <section aria-label="运行模式">
      <h2 class="guide__title">运行模式</h2>
      <ul class="guide__modes">
        <li v-for="mode in modeOrder" :key="mode">
          <strong>{{ modeLabels[mode]?.label ?? mode }}</strong>
          <span>{{ modeLabels[mode]?.detail }}</span>
          <span v-if="modeLabels[mode]?.available === false" class="guide__mode-tag">未开放</span>
        </li>
      </ul>
      <p class="guide__note">
        共 {{ modeOrder.length }} 种模式（{{ modeLabels['catalog-only']?.label }} /
        {{ modeLabels['direct-byok']?.label }} / {{ modeLabels['managed-generation']?.label }}），与
        「工作台 → 配置接口与隐私」中的实际选项一致；切换模式不会上传本机密钥或图片。
      </p>
    </section>

    <footer class="guide__footer" role="note">
      数据只在你点击生成后直连自定义接口；本站无遥测、无统计上报。
    </footer>
  </section>
</template>

<style scoped>
.guide {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  max-width: 46rem;
}

.guide__hero h1 {
  margin: 0 0 var(--space-2);
}

.guide__flow {
  margin: 0;
  border: 1px dashed var(--color-line);
  border-radius: var(--radius-card);
  padding: var(--space-3) var(--space-4);
  color: var(--color-ink);
}

.guide__title {
  margin: 0 0 var(--space-3);
  font-size: 1.125rem;
}

.guide__priorities {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.guide__priorities li {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.guide__order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 999px;
  background: var(--color-accent-teal);
  color: var(--color-on-teal);
  font-size: 0.875rem;
  flex-shrink: 0;
}

.guide__priorities p {
  margin: var(--space-1) 0 0;
  color: var(--color-ink-secondary);
}

.guide__structure {
  margin: 0;
  padding-inline-start: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.guide__note {
  margin: var(--space-3) 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.guide__cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (max-width: 640px) {
  .guide__cards {
    grid-template-columns: 1fr;
  }
}

.guide__card {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: var(--space-4);
}

.guide__card p {
  margin: var(--space-2) 0 0;
  color: var(--color-ink-secondary);
}

.guide__text {
  margin: 0;
  color: var(--color-ink);
}

.guide__modes {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.guide__modes li {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  padding: var(--space-3);
}

.guide__modes span {
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}

.guide__mode-tag {
  display: inline-block;
  align-self: flex-start;
  margin-block-start: var(--space-1);
  background: var(--color-accent-amber);
  color: var(--color-on-amber);
  border-radius: 999px;
  padding: 0 var(--space-2);
  font-size: 0.75rem;
}

.guide__footer {
  border-top: 1px solid var(--color-line);
  padding-block-start: var(--space-3);
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
}
</style>

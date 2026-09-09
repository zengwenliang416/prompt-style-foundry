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
    detail: '部署方配置身份、数据库与受管 Provider 后可用；未配置时工作台会明确提示。',
    available: true,
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
      目录浏览不上传；只有明确点击生成后，才按所选模式发送图片与提示词。本站无遥测、无统计上报。
    </footer>
  </section>
</template>

<style scoped>
.guide {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  min-width: 0;
}
.guide::after {
  content: '';
  position: absolute;
  z-index: -1;
  top: 14px;
  right: 34px;
  width: 170px;
  height: 170px;
  opacity: 0.16;
  border: 1px solid #7f9389;
  border-radius: 50%;
  background:
    linear-gradient(45deg, transparent 49.7%, #7f9389 50%, transparent 50.3%),
    linear-gradient(-45deg, transparent 49.7%, #7f9389 50%, transparent 50.3%),
    radial-gradient(circle, transparent 0 48px, #7f9389 49px, transparent 50px);
}
.guide__hero {
  grid-column: 1 / -1;
  padding: 8px 4px 24px;
  border-bottom: 1px solid var(--color-line);
}
.guide__hero h1 {
  max-width: 920px;
  margin: 0;
  color: #11171b;
  font-size: clamp(2.4rem, 4.6vw, 4.8rem);
  letter-spacing: 0.055em;
}
.guide__hero h1::after {
  content: '';
  display: block;
  width: 116px;
  height: 2px;
  margin-top: 8px;
  background: var(--color-accent-amber);
}
.guide__flow {
  display: flex;
  max-width: 880px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 24px 0 0;
  padding: 18px 24px;
  border: 1px dashed #aa9e87;
  border-radius: 9px;
  color: var(--color-teal-deep);
  background: color-mix(in srgb, var(--color-surface) 62%, transparent);
  font-family: var(--font-heading);
  font-size: 1.05rem;
  font-weight: 700;
}
.guide > section {
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--color-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-surface) 68%, transparent);
  box-shadow: 0 5px 14px rgb(69 52 28 / 7%);
}
.guide > section:first-of-type {
  grid-column: 1 / -1;
}
.guide__title {
  margin: 0 0 15px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-line);
  font-size: 1.1rem;
  letter-spacing: 0.05em;
}
.guide__title::before {
  content: '✦';
  margin-right: 7px;
  color: var(--color-accent-amber);
}
.guide__priorities {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.guide__priorities li {
  position: relative;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 12px;
  min-height: 116px;
  align-items: start;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--color-line) 80%, transparent);
  border-radius: 7px;
  background: var(--color-surface);
}
.guide__order {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  color: white;
  border-radius: 50%;
  background: var(--color-teal-deep);
  font-family: Georgia, serif;
}
.guide__priorities strong {
  font-family: var(--font-heading);
}
.guide__priorities p {
  margin: 5px 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.8rem;
}
.guide__structure {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.guide__structure li {
  position: relative;
  padding-left: 22px;
  font-size: 0.85rem;
}
.guide__structure li::before {
  content: '✓';
  position: absolute;
  left: 0;
  color: var(--color-accent-teal);
  font-weight: 700;
}
.guide__note {
  margin: 14px 0 0;
  padding: 10px 12px;
  color: var(--color-ink-secondary);
  border-left: 3px solid var(--color-accent-amber);
  background: #f5eddd;
  font-size: 0.78rem;
}
.guide__cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.guide__card {
  min-height: 116px;
  padding: 16px;
  border: 1px solid var(--color-line);
  border-radius: 7px;
  background: var(--color-surface);
}
.guide__card strong {
  color: var(--color-teal-deep);
  font-family: var(--font-heading);
}
.guide__card p {
  margin: 7px 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.8rem;
}
.guide__modes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.guide__modes li {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-line);
  border-radius: 6px;
  background: var(--color-surface);
}
.guide__modes strong {
  color: var(--color-teal-deep);
  font-family: var(--font-heading);
}
.guide__modes span {
  color: var(--color-ink-secondary);
  font-size: 0.78rem;
}
.guide__mode-tag {
  justify-self: start;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--color-on-amber);
  background: var(--color-accent-amber);
  font-size: 0.68rem;
}
.guide__footer {
  grid-column: 1 / -1;
  padding: 15px 18px;
  color: var(--color-ink-secondary);
  border: 1px solid var(--color-line);
  border-radius: 7px;
  background: color-mix(in srgb, var(--color-surface) 65%, transparent);
  font-size: 0.78rem;
  text-align: center;
}
@media (max-width: 900px) {
  .guide {
    grid-template-columns: 1fr;
  }
  .guide > section,
  .guide > section:first-of-type,
  .guide__hero,
  .guide__footer {
    grid-column: 1;
  }
  .guide__priorities {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 560px) {
  .guide__hero h1 {
    font-size: 2rem;
  }
  .guide__flow {
    align-items: flex-start;
    flex-direction: column;
  }
  .guide__flow span[aria-hidden='true'] {
    display: none;
  }
  .guide__cards {
    grid-template-columns: 1fr;
  }
  .guide__modes li {
    grid-template-columns: 1fr;
  }
}
</style>

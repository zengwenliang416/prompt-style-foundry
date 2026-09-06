<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';

import { DIRECT_BYOK_CAPABILITIES, modelCapabilities, type RunMode } from '@onepic/contracts';

import { useSettingsStore } from '../../entities/settings/store.js';
import { Button, Input } from '../../shared/ui/index.js';

/**
 * Run-mode / model / privacy settings dialog (U08). All parameter options
 * derive from the capability registry; switching modes performs no network
 * activity and never migrates the locally stored BYOK key.
 */

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const settings = useSettingsStore();
const dialogEl = useTemplateRef<HTMLDialogElement>('dialogEl');

watch(
  () => props.open,
  (open) => {
    if (open) {
      settings.load();
      // Capability-driven default: first declared model, first declared quality.
      if (settings.byokModel === '') {
        settings.byokModel = modelOptions[0]?.id ?? '';
      }
      if (
        settings.byokQuality === '' &&
        (modelCapabilities(DIRECT_BYOK_CAPABILITIES, settings.byokModel)?.qualities.length ?? 0) > 0
      ) {
        settings.byokQuality =
          modelCapabilities(DIRECT_BYOK_CAPABILITIES, settings.byokModel)?.qualities[0] ?? '';
      }
      dialogEl.value?.showModal();
      apiKeyDraft.value = '';
    }
  },
);

function close(): void {
  dialogEl.value?.close();
}

function handleClose(): void {
  emit('close');
}

const modes: Array<{ id: RunMode; label: string; hint: string; disabled?: boolean }> = [
  { id: 'catalog-only', label: '目录浏览', hint: '只浏览与复制提示词，不连接任何生成服务。' },
  {
    id: 'direct-byok',
    label: 'BYOK 直连',
    hint: '点击生成后，图片与提示词直连你自己配置的接口；密钥仅保存在本机浏览器。',
  },
  {
    id: 'managed-generation',
    label: '受管生成',
    hint: '暂未开放：需要服务端身份与授权配置（未配置时拒绝开启）。',
    disabled: true,
  },
];

const modelOptions = DIRECT_BYOK_CAPABILITIES.models;
const selectedModel = computed(() =>
  modelCapabilities(DIRECT_BYOK_CAPABILITIES, settings.byokModel),
);
const qualityOptions = computed(() => selectedModel.value?.qualities ?? []);
const aspectSupported = computed(() => selectedModel.value?.supportsInheritAspect === true);
const capabilitiesUnknown = computed(() => selectedModel.value === undefined);

const apiKeyDraft = ref('');
const savedNotice = ref('');

function saveSettings(): void {
  settings.setByokConfig(
    settings.byokEndpoint,
    settings.byokModel || modelOptions[0]?.id || '',
    settings.byokQuality || qualityOptions.value[0] || '',
  );
  if (apiKeyDraft.value.trim() !== '') {
    settings.saveApiKey(apiKeyDraft.value);
  }
  savedNotice.value = '设置已保存到本机浏览器。';
}
</script>

<template>
  <dialog ref="dialogEl" class="settings" aria-labelledby="settings-title" @close="handleClose">
    <header class="settings__header">
      <h2 id="settings-title" class="settings__title">运行模式与隐私设置</h2>
      <button type="button" class="settings__close" aria-label="关闭设置" @click="close">×</button>
    </header>

    <fieldset class="settings__modes">
      <legend>运行模式</legend>
      <label
        v-for="mode in modes"
        :key="mode.id"
        class="settings__mode"
        :class="{ 'settings__mode--disabled': mode.disabled }"
      >
        <input
          type="radio"
          name="run-mode"
          :value="mode.id"
          :checked="settings.runMode === mode.id"
          :disabled="mode.disabled"
          @change="settings.setRunMode(mode.id)"
        />
        <span>
          <strong>{{ mode.label }}</strong>
          <small>{{ mode.hint }}</small>
        </span>
      </label>
      <p class="settings__note">切换模式不会上传本机密钥或图片，也不会迁移任何数据。</p>
    </fieldset>

    <section v-if="settings.runMode === 'direct-byok'" class="settings__byok" aria-label="接口配置">
      <Input
        v-model="settings.byokEndpoint"
        label="接口地址"
        placeholder="https://your-endpoint.example.com/v1"
        autocomplete="off"
      />
      <label class="settings__field">
        模型
        <select v-model="settings.byokModel" aria-label="模型">
          <option v-for="model in modelOptions" :key="model.id" :value="model.id">
            {{ model.label }}
          </option>
        </select>
      </label>
      <label class="settings__field">
        质量
        <select
          v-model="settings.byokQuality"
          aria-label="质量"
          :disabled="qualityOptions.length === 0"
        >
          <option v-if="qualityOptions.length === 0" value="">未知能力，暂无选项</option>
          <option v-for="quality in qualityOptions" :key="quality" :value="quality">
            {{ quality }}
          </option>
        </select>
      </label>
      <p class="settings__aspect" role="status">
        比例：继承参考图（单图协议固定值）
        <template v-if="capabilitiesUnknown">；该模型能力未知，输出比例可能无法保持。</template>
        <template v-else-if="!aspectSupported"
          >；该模型不声明原生继承比例，结果可能被裁剪。</template
        >
      </p>
      <Input
        v-model="apiKeyDraft"
        label="API 密钥（仅保存在本机浏览器）"
        type="password"
        autocomplete="off"
        :placeholder="settings.hasApiKey ? '已保存——输入可覆盖' : 'sk-…'"
      />
      <p v-if="settings.hasApiKey" class="settings__note">
        本机已保存密钥；它不会随模式切换上传、迁移或同步。
      </p>
      <Button variant="secondary" @click="settings.clearApiKey()">清除本机密钥</Button>
    </section>

    <section class="settings__privacy" aria-label="隐私说明">
      <h3 class="settings__panel-title">隐私</h3>
      <ul class="settings__privacy-list">
        <li>图片仅在点击生成后发送至你配置的接口；本页无遥测、无统计上报。</li>
        <li>BYOK 密钥只保存在本机浏览器，不进入任何导出文件。</li>
        <li>受管生成开放后，密钥由服务端注入 Worker，浏览器密钥不会被迁移。</li>
      </ul>
    </section>

    <footer class="settings__footer">
      <p v-if="savedNotice" role="status" class="settings__saved">{{ savedNotice }}</p>
      <p v-if="settings.persistence === 'unavailable'" role="alert" class="settings__warning">
        本地存储不可用，设置无法保存。
      </p>
      <Button @click="saveSettings">保存设置</Button>
    </footer>
  </dialog>
</template>

<style scoped>
.settings {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-6);
  width: min(34rem, calc(100vw - 2 * var(--space-4)));
}

.settings::backdrop {
  background: rgba(31, 36, 48, 0.45);
}

.settings__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings__title {
  margin: 0;
  font-size: 1.125rem;
}

.settings__close {
  border: none;
  background: none;
  font-size: 1.25rem;
  cursor: pointer;
}

.settings__modes {
  border: none;
  padding: 0;
  margin: var(--space-4) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.settings__modes legend {
  color: var(--color-ink-secondary);
  font-size: 0.875rem;
  padding: 0;
}

.settings__mode {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  padding: var(--space-3);
  cursor: pointer;
}

.settings__mode--disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.settings__mode small {
  display: block;
  color: var(--color-ink-secondary);
}

.settings__note {
  margin: var(--space-2) 0 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.settings__byok {
  margin-block-start: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.settings__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.875rem;
}

.settings__field select {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink);
  padding: var(--space-2) var(--space-3);
}

.settings__aspect {
  margin: 0;
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
}

.settings__privacy {
  margin-block-start: var(--space-4);
}

.settings__panel-title {
  margin: 0 0 var(--space-2);
  font-size: 1rem;
}

.settings__privacy-list {
  margin: 0;
  padding-inline-start: var(--space-4);
  color: var(--color-ink-secondary);
  font-size: 0.8125rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.settings__footer {
  margin-block-start: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.settings__saved {
  margin: 0;
  color: var(--color-accent-teal);
  font-size: 0.875rem;
}

.settings__warning {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.875rem;
}
</style>

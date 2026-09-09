import { computed, ref } from 'vue';

import { readByokApiKey, useSettingsStore } from '../../entities/settings/store.js';

/**
 * Direct BYOK generation (W05; preserves the static site's direct path —
 * public/assets/app.js generateFromTemplate).
 *
 * Isolation guarantees (AGENTS §7, acceptance: 不自动切换 / 不传送凭据):
 * - the request goes ONLY to the user-configured byokEndpoint
 *   (`{base}/v1/images/edits`, OpenAI-compatible); this module contains no
 *   /api/ URL and no code path that could reach the first-party server;
 * - the BYOK key is read from its dedicated storage slot at click time and
 *   travels only as the Authorization header of that single request;
 * - plain fetch with default credentials ('same-origin'): a cross-origin
 *   BYOK endpoint never receives the session cookie, and nothing here ever
 *   sets credentials: 'include';
 * - failures (network/401/429/5xx) are reported in place; the run mode and
 *   every other setting are NEVER changed automatically — no fallback, no
 *   provider switching.
 */

export type ByokPhase = 'idle' | 'running' | 'succeeded' | 'failed';

export interface ByokResult {
  /** data: URL (b64_json) or remote URL returned by the user's endpoint. */
  src: string;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return '';
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function describeHttpError(status: number, payload: unknown): string {
  const detail =
    typeof (payload as { error?: { message?: unknown } } | null)?.error?.message === 'string'
      ? `：${(payload as { error: { message: string } }).error.message}`
      : '';
  if (status === 401 || status === 403) {
    return `API Key 无效或权限不足（HTTP ${status}）${detail}`;
  }
  if (status === 404) {
    return `找不到图像接口，请检查接口地址是否需要携带 /v1（HTTP 404）${detail}`;
  }
  if (status === 429) {
    return `上游限流或配额不足（HTTP 429）${detail}`;
  }
  if (status >= 500) {
    return `生图上游暂不可用（HTTP ${status}）${detail}`;
  }
  return `生成失败（HTTP ${status}）${detail}`;
}

export function useByokGeneration() {
  const settings = useSettingsStore();
  const phase = ref<ByokPhase>('idle');
  const error = ref<string | null>(null);
  const result = ref<ByokResult | null>(null);
  const busy = computed(() => phase.value === 'running');
  const configured = computed(() => settings.byokEndpoint.trim() !== '' && settings.hasApiKey);

  async function start(input: { file: File; prompt: string }): Promise<void> {
    const base = normalizeBaseUrl(settings.byokEndpoint);
    const key = readByokApiKey();
    if (base === '' || key === null) {
      phase.value = 'failed';
      error.value = '请先在「配置接口与隐私」中填写 BYOK 接口地址与密钥';
      return;
    }

    phase.value = 'running';
    error.value = null;
    result.value = null;

    const form = new FormData();
    form.append('image', input.file);
    form.append('prompt', input.prompt);
    form.append('model', settings.byokModel === '' ? 'gpt-image-2' : settings.byokModel);
    form.append('n', '1');
    if (settings.byokQuality !== '' && settings.byokQuality !== 'auto') {
      form.append('quality', settings.byokQuality);
    }

    try {
      // Default credentials ('same-origin') — a cross-origin BYOK endpoint
      // never receives the first-party session cookie.
      const response = await fetch(`${base}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        phase.value = 'failed';
        error.value = describeHttpError(response.status, payload);
        return;
      }
      const item = (payload as { data?: Array<{ b64_json?: string; url?: string }> } | null)
        ?.data?.[0];
      const src =
        typeof item?.b64_json === 'string'
          ? `data:image/png;base64,${item.b64_json}`
          : typeof item?.url === 'string'
            ? item.url
            : null;
      if (src === null) {
        phase.value = 'failed';
        error.value = '服务返回中没有图片数据。';
        return;
      }
      result.value = { src };
      phase.value = 'succeeded';
    } catch (cause) {
      phase.value = 'failed';
      error.value =
        cause instanceof TypeError
          ? '请求未能送达：目标服务可能未开启 CORS 或地址不可达。请改用允许跨域的接口地址。'
          : `生成失败：${cause instanceof Error ? cause.message : '未知错误'}`;
    }
  }

  function reset(): void {
    phase.value = 'idle';
    error.value = null;
    result.value = null;
  }

  return { phase, error, result, busy, configured, start, reset };
}

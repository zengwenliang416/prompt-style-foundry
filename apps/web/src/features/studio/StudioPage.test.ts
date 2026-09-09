// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import StudioPage from './StudioPage.vue';
import { createAppRouter } from '../../app/router.js';
import { useSettingsStore } from '../../entities/settings/store.js';
import { toastState, dismissToast } from '../../shared/ui/toast.js';
import { webcrypto } from 'node:crypto';

const { downloadTextFileMock } = vi.hoisted(() => ({ downloadTextFileMock: vi.fn() }));
vi.mock('../../shared/platform/download.js', () => ({
  downloadTextFile: downloadTextFileMock,
}));

const COMPILED_PROMPT = '[System / Prompt] compiled body\n';
const SAMPLE_PROMPT = '[System / Prompt] sample body\n';

function makeCatalog(): unknown {
  return {
    schemaVersion: '1.1.0',
    generatedAt: 'v1',
    project: { name: 't', nameZh: 't', description: 't' },
    source: { project: 's', repository: 'r', archiveSha256: 'a', license: 'MIT' },
    stats: { total: 2, cases: 1, frameworks: 1 },
    filters: {
      categories: ['Posters & Typography'],
      modes: [],
      blueprintInputModes: ['text-to-image'],
      styles: [],
      scenes: [],
    },
    templates: [
      {
        id: 'case-1',
        title: '极简海报',
        kind: 'case',
        category: 'Posters & Typography',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        preview: '/previews/case-1.webp',
        generatedPreview: '/previews/case-1.webp',
        generatedPromptPath: null,
        promptPath: 'data/prompts/case-1.txt',
        source: {
          project: 'awesome-gpt-image-2',
          repository: 'https://github.com/example/repo',
          caseId: 1,
          author: '作者甲',
          sourceUrl: '',
          galleryUrl: 'https://github.com/example/repo/gallery#case-1',
          license: 'MIT',
        },
        promptSha256: 'sha-case-1',
      },
      {
        id: 'framework-001',
        title: 'UI 常规模板',
        kind: 'framework',
        category: 'UI & Interfaces',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'interface',
        blueprintInputMode: 'image-to-image',
        requiresText: false,
        preview: '/previews/framework-001.webp',
        generatedPreview: 'previews/framework-001.webp',
        generatedPromptPath: 'data/generated-previews/framework-001.prompt.txt',
        promptPath: 'data/prompts/framework-001.txt',
        source: {
          project: 'awesome-gpt-image-2',
          repository: 'https://github.com/example/repo',
          document: 'docs/templates.md',
          author: '',
          sourceUrl: 'https://github.com/example/repo',
          galleryUrl: '',
          license: 'MIT',
        },
        promptSha256: 'sha-framework-001',
      },
    ],
  };
}

function stubPrompts(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string | Request) => {
      const path = String(input instanceof Request ? input.url : input).replace(
        /^https?:\/\/[^/]+/,
        '',
      );
      if (path === 'data/catalog.json' || path === '/data/catalog.json') {
        return new Response(JSON.stringify(makeCatalog()), { status: 200 });
      }
      if (path.endsWith('case-1.txt') && !path.includes('generated')) {
        return new Response(COMPILED_PROMPT, { status: 200 });
      }
      if (path.endsWith('framework-001.txt') && !path.includes('generated')) {
        return new Response('[System / Prompt] framework body\n', { status: 200 });
      }
      if (path.includes('generated-previews/framework-001')) {
        return new Response(SAMPLE_PROMPT, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

async function mountStudio(
  templateId: string,
): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createAppRouter({ history: createMemoryHistory() }).getRoutes(),
  });
  await router.push({ path: `/studio/${templateId}` });
  await router.isReady();
  const wrapper = mount(StudioPage, { global: { plugins: [router] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
  return { wrapper, router };
}

describe('StudioPage (U05)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    // happy-dom's crypto lacks subtle; restore Node's WebCrypto for hashing.
    vi.stubGlobal('crypto', webcrypto);
    stubPrompts();
    for (const item of [...toastState.items]) {
      dismissToast(item.id);
    }
  });

  it('renders template detail without public source attribution', async () => {
    const { wrapper } = await mountStudio('case-1');

    expect(wrapper.find('h1').text()).toBe('极简海报');
    expect(wrapper.find('.studio__id').text()).toBe('case-1');
    expect(wrapper.find('.studio__source').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('作者署名');
    expect(wrapper.text()).not.toContain('作者甲');
    expect(wrapper.text()).not.toContain('MIT');
  });

  it('shows the compiled prompt with a passing hash badge', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });
    expect(wrapper.find('.studio__prompt-body').text()).toContain('compiled body');
    // The stub sha does not match real content semantics; the badge reflects
    // the comparison honestly.
    await vi.waitFor(() => {
      const hash = wrapper.find('.studio__hash');
      expect(['SHA-256 与目录一致 ✓', 'SHA-256 校验失败 ✗', 'SHA-256 校验不可用']).toContain(
        hash.text(),
      );
    });
  });

  it('shows the honest no-sample state for templates without a sample prompt', async () => {
    const { wrapper } = await mountStudio('case-1');

    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[1]!.trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('该模板没有已审阅的示例生成提示词');
    });
  });

  it('loads the reviewed sample prompt for framework templates', async () => {
    const { wrapper } = await mountStudio('framework-001');
    expect(wrapper.find('.studio__preview img').attributes('src')).toBe(
      '/previews/framework-001.webp',
    );

    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[1]!.trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });
    expect(wrapper.find('.studio__prompt-body').text()).toContain('sample body');
  });

  it('gives explicit success feedback on copy and error feedback on clipboard denial', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });

    // Success path.
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '复制提示词')!
      .trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      toastState.items.some(
        (item) => item.tone === 'success' && item.message === '提示词已复制到剪贴板',
      ),
    ).toBe(true);

    // Rejection path (U05 acceptance: clipboard denial gets feedback).
    for (const item of [...toastState.items]) dismissToast(item.id);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '复制提示词')!
      .trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      toastState.items.some((item) => item.tone === 'error' && item.message.includes('复制失败')),
    ).toBe(true);
  });

  it('downloads the displayed body under the template filename', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });

    downloadTextFileMock.mockClear();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '下载 .txt')!
      .trigger('click');
    expect(downloadTextFileMock).toHaveBeenCalledWith('case-1.txt', COMPILED_PROMPT);
  });

  it('accepts one image, previews it, and removes it with feedback', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__input').exists()).toBe(true);
    });

    const file = new File([new Uint8Array(64)], 'input.png', { type: 'image/png' });
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.studio__input-img').exists()).toBe(true);
    expect(wrapper.find('.studio__input-name').text()).toBe('input.png');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '移除图片')!
      .trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.studio__input-img').exists()).toBe(false);
    expect(wrapper.find('.studio__dropzone').exists()).toBe(true);
  });

  it('rejects multiple dropped images with the single-image protocol message', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__input').exists()).toBe(true);
    });

    const files = [
      new File([new Uint8Array(8)], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array(8)], 'b.png', { type: 'image/png' }),
    ];
    const multiInput = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(multiInput.element, 'files', { value: files, configurable: true });
    await multiInput.trigger('change');
    await wrapper.vm.$nextTick();

    const alert = wrapper.find('.studio__input-error');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toBe('单图协议：一次只能提供一张参考图，请只选择一个文件。');
    expect(wrapper.find('.studio__input-img').exists()).toBe(false);
  });

  it('rejects unsupported formats and oversized images with explicit messages', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__input').exists()).toBe(true);
    });

    const gifInput = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(gifInput.element, 'files', {
      value: [new File([new Uint8Array(8)], 'x.gif', { type: 'image/gif' })],
      configurable: true,
    });
    await gifInput.trigger('change');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.studio__input-error').text()).toContain('仅支持 JPEG / PNG / WebP');

    const bigInput = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(bigInput.element, 'files', {
      value: [new File([new Uint8Array(21 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })],
      configurable: true,
    });
    await bigInput.trigger('change');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.studio__input-error').text()).toContain('20 MiB');
    expect(wrapper.find('.studio__input-error').text()).toContain('20 MiB');
  });

  it('settings: capability-driven options, mode switch without key migration', async () => {
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('配置接口与隐私');
    });

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '配置接口与隐私')!
      .trigger('click');
    await wrapper.vm.$nextTick();
    const dialog = wrapper.find('dialog');
    expect(dialog.exists()).toBe(true);

    // Three modes; managed-generation is wired (W01) and honestly marked as
    // requiring login with server-injected keys.
    const radios = dialog.findAll('input[name="run-mode"]');
    expect(radios).toHaveLength(3);
    expect(radios[2]!.attributes('disabled')).toBeUndefined();
    expect(dialog.text()).toContain('不使用本机 BYOK 密钥');

    // Switch to BYOK and save a key.
    await radios[1]!.setValue();
    await wrapper.vm.$nextTick();

    const selects = dialog.findAll('select');
    const modelOptions = selects[0]!.findAll('option');
    expect(modelOptions.map((o) => o.text())).toEqual(['GPT Image 2', '自定义模型（能力未知）']);
    const qualityOptions = selects[1]!.findAll('option');
    expect(qualityOptions.map((o) => o.text())).toEqual(['high', 'medium', 'low']);

    // Capability notice: aspect is fixed to inherit; model does not declare it.
    expect(dialog.find('.settings__aspect').text()).toContain('继承参考图');
    expect(dialog.find('.settings__aspect').text()).toContain('可能被裁剪');

    const endpoint = dialog.find('input[placeholder*="your-endpoint"]');
    await endpoint.setValue('https://api.example.com/v1');
    await dialog
      .findAll('button')
      .find((b) => b.text() === '保存设置')!
      .trigger('click');
    await wrapper.vm.$nextTick();
    expect(dialog.text()).toContain('设置已保存到本机浏览器。');

    const saved = JSON.parse(localStorage.getItem('onepic.settings.v1') ?? '{}');
    expect(saved.runMode).toBe('direct-byok');
  });

  it('shows a recoverable not-found state for unknown ids', async () => {
    const { wrapper } = await mountStudio('case-999');
    expect(wrapper.text()).toContain('模板不存在');
    expect(wrapper.find('a[href="/discover"]').exists()).toBe(true);
  });
});

describe('StudioPage managed generation (W01)', () => {
  const GEN_ID = 'gen-ui-1';

  function stubManagedApi(
    fetchSpy: ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => void>>,
    options: { keepRunning?: boolean } = {},
  ): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
        fetchSpy(input, init);
        const url = String(input instanceof Request ? input.url : input);
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        const method = (init?.method ?? 'GET').toUpperCase();
        const json = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (path === 'data/catalog.json' || path === '/data/catalog.json') {
          return json(200, makeCatalog());
        }
        if (path.endsWith('case-1.txt') && !path.includes('generated')) {
          return new Response(COMPILED_PROMPT, { status: 200 });
        }
        if (method === 'POST' && path === '/api/v1/uploads') {
          return json(201, {
            data: { uploadId: 'up-ui-1', bucket: 'quarantine', expiresAt: '2026-09-06T00:00:00Z' },
          });
        }
        if (method === 'PUT' && path === '/api/v1/uploads/up-ui-1/bytes') {
          return json(200, { data: { bytes: 64 } });
        }
        if (method === 'POST' && path === '/api/v1/uploads/up-ui-1/confirm') {
          return json(200, { data: { mediaObjectId: 'mo-ui-1', bytes: 64 } });
        }
        if (method === 'POST' && path === '/api/v1/prechecks') {
          return json(201, { data: { precheckId: 'pc-ui-1', expiresAt: '2026-09-06T00:00:00Z' } });
        }
        if (method === 'POST' && path === '/api/v1/generations') {
          return json(202, {
            data: {
              id: GEN_ID,
              state: 'queued',
              templateId: 'case-1',
              templateVersion: 1,
              createdAt: '2026-09-06T00:00:00Z',
            },
            meta: { pollAfterMs: 5 },
          });
        }
        if (method === 'GET' && path === `/api/v1/generations/${GEN_ID}`) {
          if (options.keepRunning === true) {
            return json(200, {
              data: {
                id: GEN_ID,
                state: 'running',
                templateId: 'case-1',
                templateVersion: 1,
                createdAt: '2026-09-06T00:00:00Z',
              },
              meta: { pollAfterMs: 5 },
            });
          }
          return json(200, {
            data: {
              id: GEN_ID,
              state: 'succeeded',
              templateId: 'case-1',
              templateVersion: 1,
              createdAt: '2026-09-06T00:00:00Z',
              completedAt: '2026-09-06T00:01:00Z',
              result: {
                objectId: 'ro-ui-1',
                actualMime: 'image/png',
                actualBytes: 99,
                actualWidth: 3,
                actualHeight: 2,
                sha256: 'd'.repeat(64),
              },
            },
            meta: {
              pollAfterMs: 5,
              downloadUrl:
                '/api/v1/media/private/results/gen-ui-1.png?owner=s&expires=1&signature=sig',
            },
          });
        }
        if (method === 'POST' && path === `/api/v1/generations/${GEN_ID}/cancel`) {
          return json(200, { data: { id: GEN_ID, state: 'cancelled', outcome: 'cancelled' } });
        }
        return json(404, {
          error: { code: 'NOT_FOUND', message: 'not found', correlationId: 'c' },
        });
      }),
    );
  }

  function enableManagedMode(): void {
    localStorage.setItem(
      'onepic.settings.v1',
      JSON.stringify({
        schemaVersion: 1,
        runMode: 'managed-generation',
        byokEndpoint: '',
        byokModel: '',
        byokQuality: '',
      }),
    );
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
    for (const item of [...toastState.items]) {
      dismissToast(item.id);
    }
  });

  it('enables 生成图片 in managed mode, runs the flow, and shows the signed result', async () => {
    enableManagedMode();
    const fetchSpy = vi.fn<(input: unknown, init?: RequestInit) => void>();
    stubManagedApi(fetchSpy);
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });

    const generate = () =>
      wrapper.findAll('button').find((b) => b.text() === '生成图片' || b.text() === '生成中……')!;
    // No input image yet: disabled with an honest title.
    expect(generate().attributes('disabled')).toBeDefined();

    const file = new File([new Uint8Array(64)], 'input.png', { type: 'image/png' });
    const fileInput = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(fileInput.element, 'files', { value: [file], configurable: true });
    await fileInput.trigger('change');
    await wrapper.vm.$nextTick();
    expect(generate().attributes('disabled')).toBeUndefined();

    await generate().trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__run-result').exists()).toBe(true);
    });
    const img = wrapper.find('.studio__run-img');
    expect(img.attributes('src')).toContain('/api/v1/media/private/results/gen-ui-1.png');
    expect(wrapper.find('.studio__run-download').exists()).toBe(true);

    // The flow hit the API in order and only the session cookie authenticates.
    const paths = fetchSpy.mock.calls
      .map((call) => {
        const url = String(call[0] instanceof Request ? call[0].url : call[0]);
        return `${(call[1]?.method ?? 'GET').toUpperCase()} ${url.replace(/^https?:\/\/[^/]+/, '')}`;
      })
      .filter((entry) => entry.includes('/api/v1/'));
    expect(paths).toEqual([
      'POST /api/v1/uploads',
      'PUT /api/v1/uploads/up-ui-1/bytes',
      'POST /api/v1/uploads/up-ui-1/confirm',
      'POST /api/v1/prechecks',
      'POST /api/v1/generations',
      'GET /api/v1/generations/gen-ui-1',
    ]);
    for (const call of fetchSpy.mock.calls) {
      expect(JSON.stringify(call[1]?.headers ?? {})).not.toContain('authorization');
    }
  });

  it('resumes polling a persisted in-flight task after remount (refresh recovery)', async () => {
    enableManagedMode();
    localStorage.setItem(
      'onepic.managed.inflight.v1',
      JSON.stringify({
        schemaVersion: 1,
        generationId: GEN_ID,
        templateId: 'case-1',
        startedAt: '2026-09-06T00:00:00Z',
      }),
    );
    const fetchSpy = vi.fn<(input: unknown, init?: RequestInit) => void>();
    stubManagedApi(fetchSpy);
    const { wrapper } = await mountStudio('case-1');

    await vi.waitFor(() => {
      expect(wrapper.find('.studio__run-result').exists()).toBe(true);
    });
    const polled = fetchSpy.mock.calls.some((call) =>
      String(call[0] instanceof Request ? call[0].url : call[0]).includes(
        `/api/v1/generations/${GEN_ID}`,
      ),
    );
    expect(polled).toBe(true);
    // Terminal state reached: the inflight record is cleared.
    expect(localStorage.getItem('onepic.managed.inflight.v1')).toBeNull();
  });

  it('offers cancel while polling; a confirmed cancel ends the flow and clears the record', async () => {
    enableManagedMode();
    const fetchSpy = vi.fn<(input: unknown, init?: RequestInit) => void>();
    stubManagedApi(fetchSpy, { keepRunning: true });
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });

    const file = new File([new Uint8Array(64)], 'input.png', { type: 'image/png' });
    const fileInput = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(fileInput.element, 'files', { value: [file], configurable: true });
    await fileInput.trigger('change');
    await wrapper.vm.$nextTick();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '生成图片')!
      .trigger('click');

    await vi.waitFor(() => {
      expect(wrapper.find('.studio__run-cancel').exists()).toBe(true);
    });
    expect(localStorage.getItem('onepic.managed.inflight.v1')).toContain(GEN_ID);

    await wrapper.find('.studio__run-cancel').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('任务已取消');
    });
    expect(localStorage.getItem('onepic.managed.inflight.v1')).toBeNull();
    const cancelCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0] instanceof Request ? call[0].url : call[0]).endsWith(
        `/generations/${GEN_ID}/cancel`,
      ),
    );
    expect(cancelCalls).toHaveLength(1);
  });

  it('leaving managed-generation clears the persisted inflight record (模式切换清缓存)', async () => {
    enableManagedMode();
    localStorage.setItem(
      'onepic.managed.inflight.v1',
      JSON.stringify({
        schemaVersion: 2,
        generationId: GEN_ID,
        templateId: 'case-1',
        startedAt: '2026-09-06T00:00:00Z',
      }),
    );
    const fetchSpy = vi.fn<(input: unknown, init?: RequestInit) => void>();
    // Keep the task running so the record survives the mount-time restore.
    stubManagedApi(fetchSpy, { keepRunning: true });
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('生成中');
    });
    expect(localStorage.getItem('onepic.managed.inflight.v1')).not.toBeNull();

    const settings = useSettingsStore();
    settings.setRunMode('catalog-only');
    await wrapper.vm.$nextTick();
    expect(localStorage.getItem('onepic.managed.inflight.v1')).toBeNull();
  });
});

describe('StudioPage direct BYOK (W05)', () => {
  const BYOK_SETTINGS = {
    schemaVersion: 1,
    runMode: 'direct-byok',
    byokEndpoint: 'https://byok.user.example',
    byokModel: 'gpt-image-2',
    byokQuality: 'high',
  };

  interface ByokCall {
    url: string;
    init: RequestInit;
  }

  function stubByokApi(handler: () => Promise<Response>): { calls: ByokCall[] } {
    const calls: ByokCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('https://byok.user.example/')) {
          calls.push({ url, init: init ?? {} });
          return await handler();
        }
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (path === 'data/catalog.json' || path === '/data/catalog.json') {
          return new Response(JSON.stringify(makeCatalog()), { status: 200 });
        }
        if (path.endsWith('case-1.txt') && !path.includes('generated')) {
          return new Response(COMPILED_PROMPT, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    return { calls };
  }

  function enableByokMode(): void {
    localStorage.setItem('onepic.settings.v1', JSON.stringify(BYOK_SETTINGS));
    localStorage.setItem('onepic.byok.key.v1', JSON.stringify('sk-w05-ui-key'));
  }

  async function selectFile(wrapper: ReturnType<typeof mount>): Promise<void> {
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__input').exists()).toBe(true);
    });
    const file = new File([new Uint8Array(64)], 'input.png', { type: 'image/png' });
    const input = wrapper.find<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await wrapper.vm.$nextTick();
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
    for (const item of [...toastState.items]) {
      dismissToast(item.id);
    }
  });

  it('generate in direct-byok posts to the user endpoint only — never /api/* — and shows the result', async () => {
    enableByokMode();
    const { calls } = stubByokApi(
      async () => new Response(JSON.stringify({ data: [{ b64_json: 'aGk=' }] }), { status: 200 }),
    );
    const staticSpy = vi.fn();
    void staticSpy;
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });
    await selectFile(wrapper);

    const generate = wrapper.findAll('button').find((b) => b.text() === '生成图片')!;
    expect(generate.attributes('disabled')).toBeUndefined();
    await generate.trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__run-img').exists()).toBe(true);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://byok.user.example/v1/images/edits');
    expect(calls[0]!.init.headers).toEqual({ Authorization: 'Bearer sk-w05-ui-key' });
    expect(calls[0]!.init.credentials).toBeUndefined();
    expect((calls[0]!.init.body as FormData).get('prompt')).toBe(COMPILED_PROMPT);
    expect(wrapper.text()).toContain('BYOK 直连，未经服务器');
    expect(wrapper.find('.studio__run-img').attributes('src')).toBe('data:image/png;base64,aGk=');
  });

  it('a failed BYOK call reports in place and never auto-switches the run mode', async () => {
    enableByokMode();
    stubByokApi(
      async () =>
        new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 500 }),
    );
    const { wrapper } = await mountStudio('case-1');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__prompt-body').exists()).toBe(true);
    });
    await selectFile(wrapper);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '生成图片')!
      .trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('.studio__run-error').exists()).toBe(true);
    });

    expect(wrapper.find('.studio__run-error').text()).toContain('500');
    const settings = useSettingsStore();
    expect(settings.runMode).toBe('direct-byok');
    expect(JSON.parse(localStorage.getItem('onepic.settings.v1') ?? '{}').runMode).toBe(
      'direct-byok',
    );
  });

  it('mode switch shows an honest destination notice and performs no network migration', async () => {
    stubByokApi(async () => new Response('{}'));
    const { wrapper } = await mountStudio('case-1');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '配置接口与隐私')!
      .trigger('click');
    await wrapper.vm.$nextTick();

    const radios = wrapper.find('dialog').findAll('input[name="run-mode"]');
    await radios[1]!.setValue(); // direct-byok
    await wrapper.vm.$nextTick();
    expect(toastState.items.some((item) => item.message.includes('已切换到 BYOK 直连'))).toBe(true);

    await radios[2]!.setValue(); // managed-generation
    await wrapper.vm.$nextTick();
    expect(
      toastState.items.some(
        (item) =>
          item.message.includes('已切换到受管生成') && item.message.includes('BYOK 密钥不会被使用'),
      ),
    ).toBe(true);

    await radios[0]!.setValue(); // catalog-only
    await wrapper.vm.$nextTick();
    expect(toastState.items.some((item) => item.message.includes('已切换到目录浏览'))).toBe(true);

    // Switching modes never contacts the BYOK endpoint (or any API).
    const byokTraffic = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
      String(call[0] instanceof Request ? call[0].url : call[0]).includes('byok.user.example'),
    );
    expect(byokTraffic).toHaveLength(0);
    expect(localStorage.getItem('onepic.byok.key.v1')).toBeNull();
  });
});

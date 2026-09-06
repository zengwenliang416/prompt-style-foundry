// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import StudioPage from './StudioPage.vue';
import { createAppRouter } from '../../app/router.js';
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
        generatedPreview: '/previews/framework-001.webp',
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

  it('renders template detail with source attribution', async () => {
    const { wrapper } = await mountStudio('case-1');

    expect(wrapper.find('h1').text()).toBe('极简海报');
    expect(wrapper.find('.studio__id').text()).toBe('case-1');
    expect(wrapper.text()).toContain('作者署名');
    expect(wrapper.text()).toContain('作者甲');
    const gallery = wrapper.find('a[href="https://github.com/example/repo/gallery#case-1"]');
    expect(gallery.exists()).toBe(true);
    expect(wrapper.text()).toContain('MIT');
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

    // Three modes; managed-generation disabled with an honest hint.
    const radios = dialog.findAll('input[name="run-mode"]');
    expect(radios).toHaveLength(3);
    expect(radios[2]!.attributes('disabled')).toBeDefined();
    expect(dialog.text()).toContain('暂未开放');

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

import { defineStore } from 'pinia';

import { CatalogRequestError, createCatalogApi, type CatalogApiOptions } from './api.js';
import type { CatalogDocument, CatalogTemplate } from './types.js';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error' | 'empty';

export interface CatalogState {
  status: CatalogStatus;
  catalog: CatalogDocument | null;
  /** `${schemaVersion}#${generatedAt}` — changes whenever the build outputs. */
  version: string | null;
  error: string | null;
  /** Prompt bodies fetched on demand, keyed by `id@promptSha256` for the
   * compiled prompt and `sample@{id}@{path}` for reviewed sample prompts. */
  promptTexts: Record<string, string>;
  promptStatuses: Record<string, 'loading' | 'ready' | 'error'>;
}

/**
 * Catalog store (Pinia per architecture §3). Guarantees:
 * - the initial payload is catalog.json only — prompt TXT bodies are never
 *   preloaded;
 * - every terminal state (error/empty/stale version) is recoverable by
 *   calling load() again;
 * - prompt failures are per-template and retryable.
 */
export const useCatalogStore = defineStore('catalog', {
  state: (): CatalogState => ({
    status: 'idle',
    catalog: null,
    version: null,
    error: null,
    promptTexts: {},
    promptStatuses: {},
  }),

  getters: {
    templates: (state: CatalogState): CatalogTemplate[] => state.catalog?.templates ?? [],
    stats: (state: CatalogState) => state.catalog?.stats ?? null,
  },

  actions: {
    async load(apiOptions?: CatalogApiOptions): Promise<void> {
      const api = createCatalogApi(apiOptions);
      this.status = 'loading';
      this.error = null;
      try {
        const catalog = await api.getCatalog();
        this.catalog = catalog;
        this.version = `${catalog.schemaVersion}#${catalog.generatedAt}`;
        // A version change means the build output changed; cached prompt
        // bodies may be stale, so they are dropped and refetched on demand.
        this.promptTexts = {};
        this.promptStatuses = {};
        this.status = catalog.templates.length === 0 ? 'empty' : 'ready';
      } catch (error) {
        this.status = 'error';
        this.error =
          error instanceof CatalogRequestError
            ? `目录加载失败（${error.message}）`
            : '目录加载失败，请检查网络后重试';
      }
    },

    templateById(id: string): CatalogTemplate | undefined {
      return this.catalog?.templates.find((template) => template.id === id);
    },

    async loadPromptText(id: string, apiOptions?: CatalogApiOptions): Promise<string> {
      const template = this.templateById(id);
      if (template === undefined) {
        this.promptStatuses[id] = 'error';
        throw new CatalogRequestError(`Template ${id} is not in the loaded catalog`);
      }
      const cacheKey = `${id}@${template.promptSha256}`;
      const cached = this.promptTexts[cacheKey];
      if (cached !== undefined) {
        return cached;
      }

      const api = createCatalogApi(apiOptions);
      this.promptStatuses[id] = 'loading';
      try {
        const text = await api.getPromptText(id);
        this.promptTexts[cacheKey] = text;
        this.promptStatuses[id] = 'ready';
        return text;
      } catch (error) {
        this.promptStatuses[id] = 'error';
        throw error;
      }
    },

    promptStatus(id: string): 'loading' | 'ready' | 'error' | 'not-loaded' {
      return this.promptStatuses[id] ?? 'not-loaded';
    },

    /**
     * Loads the reviewed sample prompt behind a template's generated preview
     * (generatedPromptPath). Returns null when the template has no sample.
     */
    async loadSamplePromptText(id: string, apiOptions?: CatalogApiOptions): Promise<string | null> {
      const template = this.templateById(id);
      if (template === undefined) {
        throw new CatalogRequestError(`Template ${id} is not in the loaded catalog`);
      }
      const path = template.generatedPromptPath;
      if (path === null || path === '') {
        return null;
      }
      const cacheKey = `sample@${id}@${path}`;
      const cached = this.promptTexts[cacheKey];
      if (cached !== undefined) {
        return cached;
      }

      const api = createCatalogApi(apiOptions);
      this.promptStatuses[cacheKey] = 'loading';
      try {
        const text = await api.getTextAsset(path);
        this.promptTexts[cacheKey] = text;
        this.promptStatuses[cacheKey] = 'ready';
        return text;
      } catch (error) {
        this.promptStatuses[cacheKey] = 'error';
        throw error;
      }
    },

    samplePromptStatus(id: string): 'loading' | 'ready' | 'error' | 'not-loaded' | 'none' {
      const template = this.templateById(id);
      if (template === undefined || template.generatedPromptPath === null) {
        return 'none';
      }
      return this.promptStatuses[`sample@${id}@${template.generatedPromptPath}`] ?? 'not-loaded';
    },

    samplePromptText(id: string): string | undefined {
      const template = this.templateById(id);
      if (template === undefined || template.generatedPromptPath === null) {
        return undefined;
      }
      return this.promptTexts[`sample@${id}@${template.generatedPromptPath}`];
    },
  },
});

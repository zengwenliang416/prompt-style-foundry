import type { CatalogDocument } from './types.js';

export interface CatalogApiOptions {
  /** Origin prefix for static assets; empty = same origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds before a hanging request aborts. */
  timeoutMs?: number;
}

export class CatalogRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CatalogRequestError';
    this.status = status;
  }
}

/**
 * Thin fetch adapter for the static catalog (AGENTS §7: catalog metadata and
 * full prompt TXT files stay separate so the initial payload stays small —
 * prompt bodies are fetched strictly on demand).
 */
export function createCatalogApi(options: CatalogApiOptions = {}) {
  // Default to the app base (import.meta.env.BASE_URL) so catalog requests
  // stay origin-correct under nested SPA routes like /studio/case-1 — a bare
  // relative path would resolve against the route directory.
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  function targetUrl(path: string): string {
    if (baseUrl === '') {
      return path;
    }
    const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    if (/^https?:\/\//i.test(cleanBase)) {
      return new URL(path, cleanBase).toString();
    }
    // Root-relative base (vite BASE_URL): origin-absolute path.
    return `${cleanBase}${path}`;
  }

  async function requestText(path: string, init?: RequestInit): Promise<string> {
    const response = await doFetch(targetUrl(path), {
      signal: AbortSignal.timeout(timeoutMs),
      ...init,
    });
    if (!response.ok) {
      throw new CatalogRequestError(`Request failed for ${path}`, response.status);
    }
    return response.text();
  }

  function parseCatalog(raw: string): CatalogDocument {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CatalogRequestError('Catalog response is not valid JSON');
    }
    const doc = parsed as Partial<CatalogDocument> | null;
    if (
      doc === null ||
      typeof doc !== 'object' ||
      !Array.isArray(doc.templates) ||
      typeof doc.schemaVersion !== 'string'
    ) {
      throw new CatalogRequestError('Catalog response does not match the expected schema');
    }
    return doc as CatalogDocument;
  }

  return {
    async getCatalog(): Promise<CatalogDocument> {
      return parseCatalog(await requestText('data/catalog.json'));
    },

    /** Fetches a single prompt body on demand; callers must not preload. */
    async getPromptText(templateId: string): Promise<string> {
      return requestText(`data/prompts/${encodeURIComponent(templateId)}.txt`);
    },

    /** Fetches an arbitrary catalog-referenced text asset (e.g. the sample
     * prompt behind a reviewed preview). Callers pass catalog paths only. */
    async getTextAsset(relativePath: string): Promise<string> {
      if (!relativePath.startsWith('data/') || relativePath.includes('..')) {
        throw new CatalogRequestError('Unexpected asset path');
      }
      return requestText(relativePath);
    },
  };
}

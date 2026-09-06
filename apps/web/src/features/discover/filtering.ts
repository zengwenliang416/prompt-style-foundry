import type { CatalogTemplate } from '../../entities/catalog/types.js';

export interface DiscoverQuery {
  /** Free text: matches title, id, category, styles, scenes. */
  q: string;
  /** Exact category or '' for all. */
  category: string;
  /** Original blueprint input type ('text-to-image' | 'image-to-image') or ''. */
  mode: string;
  sort: 'catalog' | 'title' | 'id';
}

export const DEFAULT_QUERY: DiscoverQuery = { q: '', category: '', mode: '', sort: 'catalog' };

export const PAGE_SIZE = 24;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesQuery(template: CatalogTemplate, q: string): boolean {
  const needle = normalize(q);
  if (needle === '') {
    return true;
  }
  return (
    normalize(template.title).includes(needle) ||
    normalize(template.id).includes(needle) ||
    normalize(template.category).includes(needle) ||
    template.styles.some((style) => normalize(style).includes(needle)) ||
    template.scenes.some((scene) => normalize(scene).includes(needle))
  );
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });

/**
 * Pure filter/sort pipeline for the discover page. Blueprint input type is a
 * property of the template in the catalog — it is NOT one of the run modes
 * (catalog-only / direct-BYOK / managed-generation) and must not be
 * presented as one.
 */
export function filterTemplates(
  templates: CatalogTemplate[],
  query: DiscoverQuery,
): CatalogTemplate[] {
  const filtered = templates.filter((template) => {
    if (query.category !== '' && template.category !== query.category) {
      return false;
    }
    if (query.mode !== '' && template.blueprintInputMode !== query.mode) {
      return false;
    }
    return matchesQuery(template, query.q);
  });

  switch (query.sort) {
    case 'title':
      return [...filtered].sort((a, b) => collator.compare(a.title, b.title));
    case 'id':
      return [...filtered].sort((a, b) => collator.compare(a.id, b.id));
    default:
      return filtered;
  }
}

/** Parses router query into a sanitized DiscoverQuery. */
export function queryFromParams(params: Record<string, unknown>): DiscoverQuery {
  const q = typeof params['q'] === 'string' ? params['q'] : '';
  const category = typeof params['category'] === 'string' ? params['category'] : '';
  const rawMode = typeof params['mode'] === 'string' ? params['mode'] : '';
  const rawSort = typeof params['sort'] === 'string' ? params['sort'] : 'catalog';
  const mode = rawMode === 'text-to-image' || rawMode === 'image-to-image' ? rawMode : '';
  const sort = rawSort === 'title' || rawSort === 'id' ? rawSort : 'catalog';
  return { q, category, mode, sort };
}

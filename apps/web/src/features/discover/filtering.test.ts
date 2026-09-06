import { describe, expect, it } from 'vitest';

import type { CatalogTemplate } from '../../entities/catalog/types.js';
import { DEFAULT_QUERY, PAGE_SIZE, filterTemplates, queryFromParams } from './filtering.js';

function template(overrides: Partial<CatalogTemplate>): CatalogTemplate {
  return {
    id: 'case-000',
    title: '示例模板',
    kind: 'case',
    category: 'Posters & Typography',
    styles: ['Poster'],
    scenes: ['Tech'],
    tags: [],
    language: 'zh',
    mode: 'poster',
    blueprintInputMode: 'text-to-image',
    requiresText: false,
    preview: '',
    generatedPreview: null,
    generatedPromptPath: null,
    promptPath: '',
    source: null,
    promptSha256: 'sha',
    ...overrides,
  };
}

const fixtures: CatalogTemplate[] = [
  template({ id: 'case-1', title: '极简海报', blueprintInputMode: 'text-to-image' }),
  template({
    id: 'case-2',
    title: '人像写真',
    category: 'Photography & Realism',
    blueprintInputMode: 'image-to-image',
    scenes: ['Studio'],
  }),
  template({ id: 'framework-001', title: 'UI 常规模板', category: 'UI & Interfaces' }),
];

describe('filterTemplates (U04)', () => {
  it('returns everything untouched with the default query', () => {
    expect(filterTemplates(fixtures, DEFAULT_QUERY)).toHaveLength(3);
  });

  it('searches title, id, category, styles and scenes', () => {
    expect(filterTemplates(fixtures, { ...DEFAULT_QUERY, q: '海报' }).map((t) => t.id)).toEqual([
      'case-1',
    ]);
    expect(
      filterTemplates(fixtures, { ...DEFAULT_QUERY, q: 'framework' }).map((t) => t.id),
    ).toEqual(['framework-001']);
    expect(
      filterTemplates(fixtures, { ...DEFAULT_QUERY, q: 'Photography' }).map((t) => t.id),
    ).toEqual(['case-2']);
    expect(filterTemplates(fixtures, { ...DEFAULT_QUERY, q: 'tech' }).map((t) => t.id)).toEqual([
      'case-1',
      'framework-001',
    ]);
    expect(filterTemplates(fixtures, { ...DEFAULT_QUERY, q: 'studio' }).map((t) => t.id)).toEqual([
      'case-2',
    ]);
  });

  it('combines category, blueprint type and text search', () => {
    const query = { ...DEFAULT_QUERY, category: 'Posters & Typography', mode: 'image-to-image' };
    expect(filterTemplates(fixtures, query)).toHaveLength(0);

    const query2 = { ...DEFAULT_QUERY, category: 'Photography & Realism', mode: 'image-to-image' };
    expect(filterTemplates(fixtures, query2).map((t) => t.id)).toEqual(['case-2']);
  });

  it('sorts by title and id with a zh collation', () => {
    const sorted = filterTemplates(fixtures, { ...DEFAULT_QUERY, sort: 'title' });
    expect(sorted[0]?.id).toBe('case-1');

    const byId = filterTemplates(fixtures, { ...DEFAULT_QUERY, sort: 'id' });
    expect(byId.map((t) => t.id)).toEqual(['case-1', 'case-2', 'framework-001']);
  });
});

describe('queryFromParams (U04 URL recovery)', () => {
  it('parses full query params', () => {
    expect(
      queryFromParams({
        q: '海报',
        category: 'Posters & Typography',
        mode: 'text-to-image',
        sort: 'title',
      }),
    ).toEqual({
      q: '海报',
      category: 'Posters & Typography',
      mode: 'text-to-image',
      sort: 'title',
    });
  });

  it('sanitizes unknown values back to defaults', () => {
    expect(queryFromParams({ mode: 'nonsense', sort: 'random' })).toEqual({
      q: '',
      category: '',
      mode: '',
      sort: 'catalog',
    });
  });

  it('ignores non-string values', () => {
    expect(queryFromParams({ q: 42, category: ['x'] })).toEqual(DEFAULT_QUERY);
  });

  it('exposes the incremental page size', () => {
    expect(PAGE_SIZE).toBeGreaterThan(0);
    expect(PAGE_SIZE).toBeLessThan(576);
  });
});

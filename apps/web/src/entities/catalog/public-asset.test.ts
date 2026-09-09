import { describe, expect, it } from 'vitest';

import { publicAssetUrl } from './public-asset';

describe('publicAssetUrl', () => {
  it('anchors portable catalog paths at the site root', () => {
    expect(publicAssetUrl('previews/framework-001.webp')).toBe('/previews/framework-001.webp');
    expect(publicAssetUrl('./previews/case-1.webp')).toBe('/previews/case-1.webp');
  });

  it('preserves absolute and browser-local URLs', () => {
    expect(publicAssetUrl('/previews/case-1.webp')).toBe('/previews/case-1.webp');
    expect(publicAssetUrl('https://example.test/image.webp')).toBe(
      'https://example.test/image.webp',
    );
    expect(publicAssetUrl('data:image/png;base64,eA==')).toBe('data:image/png;base64,eA==');
    expect(publicAssetUrl('blob:https://example.test/id')).toBe('blob:https://example.test/id');
  });

  it('returns an empty string for missing paths', () => {
    expect(publicAssetUrl(null)).toBe('');
    expect(publicAssetUrl(undefined)).toBe('');
    expect(publicAssetUrl('')).toBe('');
  });
});

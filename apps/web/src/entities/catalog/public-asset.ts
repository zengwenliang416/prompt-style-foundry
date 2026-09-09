/**
 * Resolve generated catalog asset paths from the site root.
 *
 * Catalog JSON intentionally stores portable paths such as
 * `previews/framework-001.webp`. Without the leading slash, a deep SPA route
 * like `/studio/framework-001` would request `/studio/previews/...`.
 */
export function publicAssetUrl(path: string | null | undefined): string {
  if (path === null || path === undefined || path === '') {
    return '';
  }
  if (path.startsWith('/') || /^(?:https?:|data:|blob:)/u.test(path)) {
    return path;
  }
  return `/${path.replace(/^\.\//u, '')}`;
}

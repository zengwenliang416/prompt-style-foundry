import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

/**
 * `vite preview` does not serve publicDir when copyPublicDir is false, so the
 * static catalog (data/*.json|txt, previews/*.webp) needs explicit handling.
 * The middleware serves only whitelisted first-level directories of the
 * repository `public/` tree with traversal protection — the built app stays
 * clean and the catalog is never duplicated into dist (W05 independence).
 */
function staticCatalogPlugin(): Plugin {
  const publicDir = resolve(__dirname, '../../public');
  const contentTypes: Record<string, string> = {
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
  };

  return {
    name: 'onepic-static-catalog-preview',
    apply: 'serve',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith('/data/') && !url.startsWith('/previews/')) {
          next();
          return;
        }
        const segments = url.split('/').filter((segment) => segment !== '');
        if (
          segments.length === 0 ||
          segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))
        ) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        const file = resolve(publicDir, ...segments);
        if (!file.startsWith(publicDir + sep)) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        readFile(file)
          .then((data) => {
            res.statusCode = 200;
            res.setHeader(
              'content-type',
              contentTypes[extname(file)] ?? 'application/octet-stream',
            );
            res.end(data);
          })
          .catch(() => {
            res.statusCode = 404;
            res.end('not found');
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), staticCatalogPlugin()],
  // Serve the repo-level static catalog on the same origin in dev (publicDir)
  // and preview (plugin above) without copying it into the build output —
  // production deploys it separately (checklist W05 keeps both independent).
  publicDir: resolve(__dirname, '../../public'),
  build: {
    copyPublicDir: false,
  },
});

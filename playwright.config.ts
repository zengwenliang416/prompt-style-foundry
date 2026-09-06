import { defineConfig } from '@playwright/test';

/**
 * Two E2E surfaces:
 * - static: the shipped static site (public/) served by scripts/serve.py.
 * - webapp: the five-page Vue app built by Vite and served by `vite preview`
 *   (provides the SPA history fallback that deep-link refresh needs).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  webServer: [
    {
      command: 'python3 scripts/serve.py --host 127.0.0.1 --port 8178',
      port: 8178,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        'npm run build -w @onepic/web && npm run preview -w @onepic/web -- --port 8179 --strictPort --host 127.0.0.1',
      port: 8179,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'static',
      testMatch: /static.*\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8178' },
    },
    {
      name: 'webapp',
      testMatch: /webapp.*\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8179' },
    },
  ],
});

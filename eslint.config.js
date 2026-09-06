import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/src/generated/**',
      '.tmp/**',
      'data/**',
      'docs/**',
      'ops/**',
      'public/**',
      'scripts/**',
      'tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...(pluginVue.configs['flat/recommended'] ?? pluginVue.configs.recommended),
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    // typescript-eslint disables core no-undef for TS files; SFC script
    // blocks run as TS too, and no-undef cannot see DOM/TS globals — type
    // correctness is enforced by vue-tsc instead.
    rules: {
      'no-undef': 'off',
    },
  },
  // Layer boundaries from docs/full-stack-architecture.md §4: pages must not
  // import backend internals; the domain layer must not depend on the HTTP
  // framework, SQL drivers, or provider SDKs; shared packages stay dependency
  //-free beyond their declared workspace deps.
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fastify',
                '@fastify/*',
                'vue',
                '@onepic/client',
                '@onepic/api',
                '@onepic/worker',
                '@onepic/web',
              ],
              message: 'contracts must stay dependency-free (architecture §4).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/client/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fastify',
                '@fastify/*',
                'vue',
                '@onepic/api',
                '@onepic/worker',
                '@onepic/web',
              ],
              message: 'client may only depend on @onepic/contracts (architecture §4).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/worker/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fastify',
                '@fastify/*',
                'vue',
                '@onepic/api',
                '@onepic/client',
                '@onepic/web',
              ],
              message:
                'worker must not depend on the HTTP framework or the web/api apps (architecture §4).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', '@fastify/*', '@onepic/api', '@onepic/worker'],
              message: 'pages must not import backend internals (architecture §4).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', '@fastify/*'],
              message:
                'domain/application modules must not depend on the HTTP framework; protocol conversion stays in bootstrap (architecture §4).',
            },
          ],
        },
      ],
    },
  },
  // The design-system directory uses the single-word component names that
  // the checklist (U01: Button/Input/Dialog/Card/Toast) prescribes.
  {
    files: ['apps/web/src/shared/ui/**'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  // Prettier owns formatting; eslint-config-prettier (last) disables the
  // stylistic rules that would otherwise fight it.
  eslintConfigPrettier,
);

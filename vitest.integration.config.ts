import { defineConfig } from 'vitest/config';

/**
 * PostgreSQL integration tests. Each run boots its own ephemeral PG 16
 * cluster (see packages/test-support) on a loopback random port and destroys
 * it afterwards; tests never point at a remote or production database.
 */
export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

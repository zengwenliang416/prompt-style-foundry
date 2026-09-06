import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../config/env.js';
import type { ApiSuccess, HealthLive, HealthReady } from '@onepic/contracts';

import { openApiSchema } from './schema.js';

/**
 * Process-level health probes (architecture §6). Response schemas come from
 * the OpenAPI document (packages/contracts/openapi/api-v1.yaml is the single
 * source of truth), so fastify serializes responses through the contract:
 * undeclared fields cannot leak out. Dependency-aware readiness semantics
 * (no paid provider probing) are finalized with checklist B06; until then
 * readiness reports `ok` because no dependencies are wired yet.
 */

export function registerHealthRoutes(app: FastifyInstance, config: ApiConfig): void {
  app.get(
    '/api/v1/health/live',
    {
      schema: {
        response: {
          200: openApiSchema('ApiSuccessOfHealthLive'),
        },
      },
    },
    async (): Promise<ApiSuccess<HealthLive>> => ({
      data: { status: 'ok' },
    }),
  );

  app.get(
    '/api/v1/health/ready',
    {
      schema: {
        response: {
          200: openApiSchema('ApiSuccessOfHealthReady'),
        },
      },
    },
    async (): Promise<ApiSuccess<HealthReady>> => {
      // Dependency-aware readiness: PG connectivity only. Provider health is
      // NEVER probed here (B06: no paid calls from health endpoints).
      if (config.databaseUrl === undefined) {
        return { data: { status: 'ok' } };
      }
      try {
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: config.databaseUrl });
        try {
          const result = await Promise.race([
            pool.query('SELECT 1'),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('readiness probe timeout')), 2000),
            ),
          ]);
          void result;
          return { data: { status: 'ok' } };
        } finally {
          await pool.end();
        }
      } catch {
        return { data: { status: 'degraded' } };
      }
    },
  );
}

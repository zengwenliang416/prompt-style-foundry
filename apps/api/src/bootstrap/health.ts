import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ApiConfig } from '../config/env.js';
import type { ApiSuccess, HealthLive, HealthReady } from '@onepic/contracts';

import { openApiSchema } from './schema.js';

/**
 * Process-level health probes (architecture §6). Response schemas come from
 * the OpenAPI document. Liveness never checks dependencies; readiness checks
 * configured PostgreSQL connectivity only and never probes a Provider.
 */

function readinessResponse(
  status: HealthReady['status'],
  reply: FastifyReply,
): ApiSuccess<HealthReady> {
  if (status === 'degraded') reply.code(503);
  return { data: { status } };
}

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
          503: openApiSchema('ApiSuccessOfHealthReady'),
        },
      },
    },
    async (_request, reply): Promise<ApiSuccess<HealthReady>> => {
      // Dependency-aware readiness never probes a Provider. Managed mode also
      // proves startup migrations and the immutable 576-template catalog import
      // completed before this replica can receive traffic.
      if (config.databaseUrl === undefined) {
        return readinessResponse('ok', reply);
      }
      try {
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: config.databaseUrl });
        try {
          const sql =
            config.runMode === 'managed-generation'
              ? `SELECT (
                  EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5)
                  AND EXISTS (SELECT 1 FROM catalog_release WHERE template_count = 576)
                  AND (SELECT count(*) FROM template_version) = 576
                  AND EXISTS (
                    SELECT 1 FROM template_version
                    WHERE template_key = 'case-532' AND version = 1
                  )
                ) AS ready`
              : 'SELECT true AS ready';
          const result = await Promise.race([
            pool.query<{ ready: boolean }>(sql),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('readiness probe timeout')), 2000),
            ),
          ]);
          return readinessResponse(result.rows[0]?.ready === true ? 'ok' : 'degraded', reply);
        } finally {
          await pool.end();
        }
      } catch {
        return readinessResponse('degraded', reply);
      }
    },
  );
}

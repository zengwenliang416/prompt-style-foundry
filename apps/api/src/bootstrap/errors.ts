import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../config/env.js';

/**
 * Unified error envelope + correlation IDs (B06, architecture §6).
 *
 * Every error — validation, not-found, unexpected — leaves as
 * `{ error: { code, message, details, correlationId } }` with a stable code
 * from the D06 catalog. Stack traces and internal messages never reach the
 * client. Each request carries a correlationId (generated or inherited via
 * x-correlation-id) that is echoed in the response header and error body for
 * log correlation.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    correlationId: string;
  };
}

export function registerErrorHandling(app: FastifyInstance, config: ApiConfig): void {
  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-correlation-id'];
    request.id =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
    reply.header('x-correlation-id', request.id);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const correlationId = request.id;
    // Fastify validation errors carry structured metadata but may embed
    // internal serializer details; expose only the human message.
    if (
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      Array.isArray((error as { validation?: unknown }).validation)
    ) {
      const violations = (error as { validation: Array<{ instancePath?: string }> }).validation.map(
        (entry) => entry.instancePath ?? '',
      );
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: { violations },
          correlationId,
        },
      };
      void reply.code(400).send(body);
      return;
    }
    if (error instanceof AppError) {
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          correlationId,
        },
      };
      void reply.code(error.statusCode).send(body);
      return;
    }
    // Unexpected: log server-side (with stack), return nothing internal.
    request.log.error({ event: 'internal_error', correlationId, error });
    const body: ErrorBody = {
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
        correlationId,
      },
    };
    void reply.code(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method}:${request.url ?? ''} not found`,
        correlationId: request.id,
      },
    };
    void reply.code(404).send(body);
  });

  void config;
}

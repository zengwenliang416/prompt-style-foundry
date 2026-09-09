import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DestinationStream, LoggerOptions } from 'pino';

import { redactText, redactValue } from '@onepic/contracts';

import type { LogLevel } from '../config/env.js';

/**
 * Structured, redacted API logging (O02, architecture §8). Fastify/pino
 * request logs would otherwise serialize the raw request — including the
 * Cookie/Authorization headers and signed media URLs' signature query param.
 * These serializers put every header through the shared redaction rules and
 * scrub credential shapes out of URLs and error messages; prompt bodies and
 * session material can never reach a log line through these surfaces.
 */
export function buildLoggerOptions(level: LogLevel, stream?: DestinationStream): LoggerOptions {
  return {
    level,
    ...(stream === undefined ? {} : { stream }),
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          // The URL may carry a signed-media signature parameter.
          url: redactText(request.url),
          host: request.host,
          remoteAddress: request.ip,
          headers: redactValue(request.headers),
        };
      },
      res(reply: FastifyReply) {
        return { statusCode: reply.statusCode };
      },
      err(error: Error) {
        return { name: error.name, message: redactText(error.message) };
      },
    },
  };
}

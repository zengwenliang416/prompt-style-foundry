import { createHash } from 'node:crypto';

/**
 * In-memory sliding-window rate limiter (B05). Single-node first phase
 * (ADR 0001); keyed per subject+action with low-cardinality keys only.
 */

export interface RateLimitOptions {
  /** Maximum hits per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly options: RateLimitOptions) {}

  hit(key: string, now: number = Date.now()): RateLimitDecision {
    const timestamps = this.hits.get(key) ?? [];
    const windowStart = now - this.options.windowMs;
    const recent = timestamps.filter((timestamp) => timestamp > windowStart);
    if (recent.length >= this.options.limit) {
      const oldest = recent[0] ?? now;
      this.hits.set(key, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.options.windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Error sanitizer: no provider keys or secrets ever surface in messages. */
export function safeQuotaError(message: string): string {
  return message.includes('sk-') || /bearer\s/i.test(message)
    ? 'internal quota error'
    : message;
}

/** Test helper mirroring the storage-side hash for quota bookkeeping keys. */
export function quotaKeyHash(subjectId: string): string {
  return createHash('sha256').update(subjectId).digest('hex').slice(0, 16);
}

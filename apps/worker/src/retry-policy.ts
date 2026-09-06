/**
 * Bounded-retry classification for provider failures (J07, architecture §9:
 * "只有有证据的 retryable 错误才重试，耗尽后进入 dead-letter").
 *
 * Rules:
 * - 401/403 (auth) and 400/404/409/422 (parameter errors) are NEVER retried;
 * - 429/503 are retried only with positive provider evidence (a Retry-After
 *   header captured by the adapter) OR when the caller proves the operation
 *   is idempotency-safe — our generation POST carries no provider idempotency
 *   key, so the managed path always classifies with idempotencySafe=false;
 * - other 5xx are retried only with explicit Retry-After evidence;
 * - PROVIDER_TIMEOUT_UNKNOWN is excluded here on purpose: it follows the J06
 *   outcome_unknown path and is never eligible for automatic retry.
 */

export interface ProviderFailureSignal {
  code: string;
  status?: number;
  retryAfterSeconds?: number;
}

export interface RetryVerdict {
  retryable: boolean;
  /** Suggested delay; the Retry-After value when present, else a default. */
  retryDelaySeconds?: number;
  rationale:
    | 'timeout_unknown_not_retryable'
    | 'auth_not_retryable'
    | 'parameter_not_retryable'
    | 'provider_evidence_retry_after'
    | 'idempotent_safe_retry'
    | 'no_retry_evidence';
}

const DEFAULT_RETRY_DELAY_SECONDS = 30;

const PARAMETER_STATUSES = new Set([400, 404, 409, 422]);
const AUTH_STATUSES = new Set([401, 403]);

export function classifyProviderFailure(
  failure: ProviderFailureSignal,
  options: { idempotencySafe: boolean },
): RetryVerdict {
  if (failure.code === 'PROVIDER_TIMEOUT_UNKNOWN') {
    return { retryable: false, rationale: 'timeout_unknown_not_retryable' };
  }
  const status = failure.status;
  if (status !== undefined) {
    if (AUTH_STATUSES.has(status)) {
      return { retryable: false, rationale: 'auth_not_retryable' };
    }
    if (PARAMETER_STATUSES.has(status)) {
      return { retryable: false, rationale: 'parameter_not_retryable' };
    }
    if (status === 429 || status === 503 || status >= 500) {
      if (failure.retryAfterSeconds !== undefined) {
        return {
          retryable: true,
          retryDelaySeconds: failure.retryAfterSeconds,
          rationale: 'provider_evidence_retry_after',
        };
      }
      if ((status === 429 || status === 503) && options.idempotencySafe) {
        return {
          retryable: true,
          retryDelaySeconds: DEFAULT_RETRY_DELAY_SECONDS,
          rationale: 'idempotent_safe_retry',
        };
      }
      return { retryable: false, rationale: 'no_retry_evidence' };
    }
  }
  return { retryable: false, rationale: 'no_retry_evidence' };
}

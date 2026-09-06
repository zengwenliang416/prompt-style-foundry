import { describe, expect, it } from 'vitest';

import { classifyProviderFailure } from './retry-policy.js';

/**
 * J07 unit coverage: the classifier decides retryability from provider
 * evidence (Retry-After) and idempotency capability — never from hope.
 */
describe('classifyProviderFailure (J07)', () => {
  it('never retries timeouts (J06 path owns them)', () => {
    const verdict = classifyProviderFailure(
      { code: 'PROVIDER_TIMEOUT_UNKNOWN', status: 504, retryAfterSeconds: 5 },
      { idempotencySafe: true },
    );
    expect(verdict.retryable).toBe(false);
    expect(verdict.rationale).toBe('timeout_unknown_not_retryable');
  });

  it.each([401, 403])('never retries auth status %s', (status) => {
    const verdict = classifyProviderFailure(
      { code: 'PROVIDER_REJECTED', status, retryAfterSeconds: 10 },
      { idempotencySafe: true },
    );
    expect(verdict.retryable).toBe(false);
    expect(verdict.rationale).toBe('auth_not_retryable');
  });

  it.each([400, 404, 409, 422])('never retries parameter status %s', (status) => {
    const verdict = classifyProviderFailure(
      { code: 'PROVIDER_REJECTED', status },
      { idempotencySafe: true },
    );
    expect(verdict.retryable).toBe(false);
    expect(verdict.rationale).toBe('parameter_not_retryable');
  });

  it.each([429, 503])('retries %s with Retry-After evidence even when not idempotent', (status) => {
    const verdict = classifyProviderFailure(
      { code: 'PROVIDER_REJECTED', status, retryAfterSeconds: 17 },
      { idempotencySafe: false },
    );
    expect(verdict).toEqual({ retryable: true, retryDelaySeconds: 17, rationale: 'provider_evidence_retry_after' });
  });

  it.each([429, 503])('refuses %s without evidence on the non-idempotent path', (status) => {
    const verdict = classifyProviderFailure(
      { code: 'PROVIDER_REJECTED', status },
      { idempotencySafe: false },
    );
    expect(verdict.retryable).toBe(false);
    expect(verdict.rationale).toBe('no_retry_evidence');
  });

  it.each([429, 503])('retries %s without evidence only when idempotency-safe', (status) => {
    const verdict = classifyProviderFailure(
      { code: 'PROVIDER_REJECTED', status },
      { idempotencySafe: true },
    );
    expect(verdict.retryable).toBe(true);
    expect(verdict.retryDelaySeconds).toBe(30);
    expect(verdict.rationale).toBe('idempotent_safe_retry');
  });

  it('retries a plain 500 only with Retry-After evidence', () => {
    expect(
      classifyProviderFailure({ code: 'PROVIDER_REJECTED', status: 500 }, { idempotencySafe: true }).retryable,
    ).toBe(false);
    expect(
      classifyProviderFailure(
        { code: 'PROVIDER_REJECTED', status: 500, retryAfterSeconds: 3 },
        { idempotencySafe: false },
      ),
    ).toEqual({ retryable: true, retryDelaySeconds: 3, rationale: 'provider_evidence_retry_after' });
  });

  it('refuses failures without any status evidence (redirect, SSRF, malformed)', () => {
    const verdict = classifyProviderFailure({ code: 'PROVIDER_REJECTED' }, { idempotencySafe: true });
    expect(verdict.retryable).toBe(false);
  });
});

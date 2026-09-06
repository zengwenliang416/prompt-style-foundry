import type { Queryable } from '../../db/queryable.js';

/**
 * Allowlisted provider adapter (J04, architecture §8).
 *
 * Security invariants (acceptance):
 * - the base URL comes from the SERVER allowlist, never from request input;
 * - redirects are refused (fetch `redirect: 'error'`) so a provider or an
 *   attacker controlling it cannot bounce requests toward internal targets;
 * - result payloads must carry base64 image data — any URL-bearing result
 *   must point at the allowlisted origin or it is rejected (no SSRF via
 *   result URLs);
 * - the Authorization header is attached to the provider request only and is
 *   never included in error messages, logs, or normalized results.
 */

export interface ProviderModelDescriptor {
  id: string;
  qualities: string[];
}

export interface ProviderDescriptor {
  providerId: string;
  label: string;
  baseUrl: string;
  /** Injected from the secret manager / managed key file — never logged. */
  apiKey: string;
  models: ProviderModelDescriptor[];
}

export interface GenerateRequest {
  model: string;
  quality: string;
  prompt: string;
  /** Input image bytes for the single-image protocol. */
  inputImage: Buffer;
  inputMime: string;
}

export interface NormalizedGeneration {
  imageBytes: Buffer;
  rawBody: Buffer;
}

export type NormalizedFailure = {
  ok: false;
  code: 'PROVIDER_REJECTED' | 'PROVIDER_TIMEOUT_UNKNOWN' | 'INTERNAL';
  status?: number;
  message: string;
  /**
   * Provider-side request identifier captured from the `x-request-id`
   * response header when the provider answered (e.g. 408/504). It is the
   * reconciliation evidence for outcome_unknown disposition (J06); absent
   * when the connection dropped before any response.
   */
  requestId?: string;
  /**
   * Parsed `Retry-After` header (seconds), captured on 429/5xx responses.
   * This is the provider evidence the bounded-retry policy (J07) requires
   * before re-sending a non-idempotent generation request.
   */
  retryAfterSeconds?: number;
};

export type ProviderOutcome =
  | { ok: true; value: NormalizedGeneration }
  | NormalizedFailure;

export class ProviderAdapter {
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly descriptor: ProviderDescriptor,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** Allowlist check: exact provider id + supported model. */
  isSupported(providerId: string, model: string): boolean {
    if (this.descriptor.providerId !== providerId) {
      return false;
    }
    return this.descriptor.models.some((m) => m.id === model);
  }

  async generate(request: GenerateRequest): Promise<ProviderOutcome> {
    if (!this.isSupported(this.descriptor.providerId, request.model)) {
      return {
        ok: false,
        code: 'PROVIDER_REJECTED',
        message: `model ${request.model} is not on the allowlist`,
      };
    }
    const origin = new URL(this.descriptor.baseUrl).origin;
    const endpoint = new URL('/v1/images/edits', origin).toString();

    let response: Response;
    try {
      response = await this.doFetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.descriptor.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          quality: request.quality,
          prompt: request.prompt,
          image: request.inputImage.toString('base64'),
          input_mime: request.inputMime,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/redirect/i.test(message)) {
        return {
          ok: false,
          code: 'PROVIDER_REJECTED',
          message: 'provider attempted a redirect, which is forbidden',
        };
      }
      return {
        ok: false,
        code: 'PROVIDER_TIMEOUT_UNKNOWN',
        message: 'provider request did not complete',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        code: 'PROVIDER_REJECTED',
        status: response.status,
        message: 'provider attempted a redirect, which is forbidden',
      };
    }
    if (response.status === 408 || response.status === 504) {
      const requestId = response.headers.get('x-request-id') ?? undefined;
      return {
        ok: false,
        code: 'PROVIDER_TIMEOUT_UNKNOWN',
        status: response.status,
        message: 'provider timed out; outcome unknown',
        ...(requestId !== undefined ? { requestId } : {}),
      };
    }
    if (response.status === 429 || response.status >= 500) {
      // Rate-limit / availability signals carry Retry-After as explicit
      // provider evidence; the J07 policy refuses to retry without it.
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      return {
        ok: false,
        code: 'PROVIDER_REJECTED',
        status: response.status,
        message: 'provider rejected the request',
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: 'PROVIDER_REJECTED',
        status: response.status,
        message: 'provider rejected the request',
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8'));
    } catch {
      return { ok: false, code: 'INTERNAL', message: 'provider response was not JSON' };
    }

    const data = (payload as { data?: Array<{ b64_json?: string; url?: string }> }).data;
    const first = Array.isArray(data) ? data[0] : undefined;
    if (first === undefined || typeof first.b64_json !== 'string') {
      // URL-bearing results are only acceptable from the allowlisted origin;
      // anything else is a SSRF vector and is rejected outright.
      const url = (first as { url?: string } | undefined)?.url;
      if (typeof url === 'string') {
        try {
          if (new URL(url).origin !== origin) {
            return { ok: false, code: 'PROVIDER_REJECTED', message: 'result URL origin is not allowlisted' };
          }
        } catch {
          return { ok: false, code: 'PROVIDER_REJECTED', message: 'result URL is malformed' };
        }
      }
      return { ok: false, code: 'PROVIDER_REJECTED', message: 'provider result missing image data' };
    }

    const imageBytes = Buffer.from(first.b64_json, 'base64');
    return { ok: true, value: { imageBytes, rawBody: Buffer.from(first.b64_json) } };
  }
}

/** Fails the given quota/ledger-like surfaces without leaking credentials. */
export function credentialFreeMessage(message: string): string {
  return message.includes('Bearer') || message.includes('sk-') ? 'redacted provider error' : message;
}

/** Parses a `Retry-After` header in delta-seconds form; anything else → undefined. */
export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || String(seconds) !== value.trim()) {
    return undefined;
  }
  return seconds;
}

export type { Queryable };

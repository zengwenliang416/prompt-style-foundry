import type { ApiFailure, ApiSuccess, HealthLive, HealthReady } from '@onepic/contracts';

export interface OnePicClientOptions {
  /** API origin, e.g. https://api.example.com. Never include secrets here. */
  baseUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Error raised for non-2xx or malformed envelope responses. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;

  constructor(status: number, code: string, message: string, correlationId?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

async function request<TData>(
  options: OnePicClientOptions,
  path: string,
  signal?: AbortSignal,
): Promise<TData> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(new URL(path, options.baseUrl), { signal });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError(response.status, 'response_not_json', 'API response was not JSON.');
  }

  if (response.ok) {
    const envelope = payload as Partial<ApiSuccess<TData>> | null;
    if (envelope === null || envelope.data === undefined) {
      throw new ApiRequestError(
        response.status,
        'response_envelope_invalid',
        'API response envelope is missing data.',
      );
    }
    return envelope.data;
  }

  const failure = payload as Partial<ApiFailure> | null;
  const errorBody = failure?.error;
  if (errorBody && typeof errorBody.code === 'string' && typeof errorBody.message === 'string') {
    throw new ApiRequestError(
      response.status,
      errorBody.code,
      errorBody.message,
      typeof errorBody.correlationId === 'string' ? errorBody.correlationId : undefined,
    );
  }
  throw new ApiRequestError(
    response.status,
    'response_error_envelope_invalid',
    'API error response did not follow the error envelope.',
  );
}

export interface OnePicClient {
  getHealthLive(signal?: AbortSignal): Promise<HealthLive>;
  getHealthReady(signal?: AbortSignal): Promise<HealthReady>;
}

export function createOnePicClient(options: OnePicClientOptions): OnePicClient {
  return {
    getHealthLive(signal?: AbortSignal): Promise<HealthLive> {
      return request<HealthLive>(options, '/api/v1/health/live', signal);
    },
    getHealthReady(signal?: AbortSignal): Promise<HealthReady> {
      return request<HealthReady>(options, '/api/v1/health/ready', signal);
    },
  };
}

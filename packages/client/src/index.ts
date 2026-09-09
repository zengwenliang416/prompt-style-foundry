import type {
  ApiFailure,
  ApiSuccess,
  AuthLogout,
  AuthMe,
  AuthRefresh,
  CollectionCreateRequest,
  CollectionDeleted,
  CollectionItem,
  CollectionItemAddRequest,
  CollectionItemRemoval,
  CollectionList,
  CollectionSummary,
  GenerationCancelResult,
  GenerationDeleteResult,
  GenerationSidecar,
  GenerationCreateRequest,
  GenerationList,
  GenerationListMeta,
  GenerationStatus,
  GenerationStatusData,
  GenerationStatusMeta,
  HealthLive,
  HealthReady,
  PrecheckCreateRequest,
  PrecheckCreated,
  UploadConfirmRequest,
  UploadConfirmed,
  UploadBytes,
  UploadCreateRequest,
  UploadSession,
  WorkspaceExport,
} from '@onepic/contracts';

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

interface RequestInit {
  method?: string;
  /** JSON-serialized body, or raw bytes for octet-stream uploads. */
  body?: unknown;
  binary?: boolean;
  headers?: Record<string, string>;
}

async function request<TData>(
  options: OnePicClientOptions,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<TData> {
  const envelope = await requestEnvelope<TData>(options, path, init, signal);
  return envelope.data;
}

async function requestEnvelope<TData>(
  options: OnePicClientOptions,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<ApiSuccess<TData>> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...init.headers };
  let body: ArrayBuffer | string | undefined;
  if (init.body !== undefined) {
    if (init.binary === true) {
      headers['content-type'] = 'application/octet-stream';
      body = init.body as ArrayBuffer;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
  }
  const response = await doFetch(new URL(path, options.baseUrl), {
    method: init.method ?? 'GET',
    headers,
    body,
    signal,
    credentials: 'include',
  });
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
    return envelope as ApiSuccess<TData>;
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
export interface SignedMediaDownload {
  bytes: ArrayBuffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

async function requestSignedMedia(
  options: OnePicClientOptions,
  signedUrl: string,
  signal?: AbortSignal,
): Promise<SignedMediaDownload> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(new URL(signedUrl, options.baseUrl), {
    method: 'GET',
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    let payload: Partial<ApiFailure> | null = null;
    try {
      payload = (await response.json()) as Partial<ApiFailure>;
    } catch {
      // Fall through to the stable generic error below.
    }
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? 'media_download_failed',
      payload?.error?.message ?? 'Signed media download failed.',
      payload?.error?.correlationId,
    );
  }
  const contentType = response.headers.get('content-type');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType ?? '')) {
    throw new ApiRequestError(
      response.status,
      'media_content_type_invalid',
      'Signed media response did not contain a supported image MIME.',
    );
  }
  return {
    bytes: await response.arrayBuffer(),
    contentType: contentType as SignedMediaDownload['contentType'],
  };
}

/** CSRF guard header required on every mutating route (identity-routes.ts). */
const CSRF_HEADER = { 'x-onepic-requested-with': 'onepic-fetch' } as const;

/** Status envelope with the W01 polling/download metadata typed. */
export type GenerationStatusEnvelope = Omit<ApiSuccess<GenerationStatusData>, 'meta'> & {
  meta?: GenerationStatusMeta;
};

/** History/collection list envelopes carry nextCursor in meta (W03). */
export type GenerationListEnvelope = Omit<ApiSuccess<GenerationList>, 'meta'> & {
  meta?: GenerationListMeta;
};
export type CollectionListEnvelope = Omit<ApiSuccess<CollectionList>, 'meta'> & {
  meta?: GenerationListMeta;
};

export interface ListGenerationsParams {
  state?: GenerationStatus;
  /** Opaque signed cursor from a previous page's meta.nextCursor. */
  cursor?: string;
  /** Page size (server caps at 50, default 20). */
  limit?: number;
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const rendered = query.toString();
  return rendered === '' ? path : `${path}?${rendered}`;
}

export interface OnePicClient {
  getHealthLive(signal?: AbortSignal): Promise<HealthLive>;
  getHealthReady(signal?: AbortSignal): Promise<HealthReady>;
  /** Browser navigation URL for the 302 OIDC login operation. */
  getLoginUrl(): string;
  /** Browser navigation URL for the 302 OIDC callback operation. */
  getLoginCallbackUrl(code: string, state: string): string;
  getCurrentSubject(signal?: AbortSignal): Promise<AuthMe>;
  refreshSession(signal?: AbortSignal): Promise<AuthRefresh>;
  logout(signal?: AbortSignal): Promise<AuthLogout>;
  getSignedMedia(signedUrl: string, signal?: AbortSignal): Promise<SignedMediaDownload>;
  createUpload(input: UploadCreateRequest, signal?: AbortSignal): Promise<UploadSession>;
  uploadBytes(uploadId: string, body: ArrayBuffer, signal?: AbortSignal): Promise<UploadBytes>;
  confirmUpload(
    uploadId: string,
    input: UploadConfirmRequest,
    signal?: AbortSignal,
  ): Promise<UploadConfirmed>;
  createPrecheck(input: PrecheckCreateRequest, signal?: AbortSignal): Promise<PrecheckCreated>;
  createGeneration(
    input: GenerationCreateRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<GenerationStatusEnvelope>;
  getGeneration(generationId: string, signal?: AbortSignal): Promise<GenerationStatusEnvelope>;
  /** Hash/metadata-only traceability record; never contains prompt bodies or keys. */
  getGenerationSidecar(generationId: string, signal?: AbortSignal): Promise<GenerationSidecar>;
  cancelGeneration(generationId: string, signal?: AbortSignal): Promise<GenerationCancelResult>;
  /** O01: deletes the result media bytes; history/hash facts stay on the server. */
  deleteGeneration(generationId: string, signal?: AbortSignal): Promise<GenerationDeleteResult>;
  listGenerations(
    params?: ListGenerationsParams,
    signal?: AbortSignal,
  ): Promise<GenerationListEnvelope>;
  listCollections(
    params?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<CollectionListEnvelope>;
  createCollection(
    input: CollectionCreateRequest,
    signal?: AbortSignal,
  ): Promise<CollectionSummary>;
  deleteCollection(collectionId: string, signal?: AbortSignal): Promise<CollectionDeleted>;
  addCollectionItem(
    collectionId: string,
    input: CollectionItemAddRequest,
    signal?: AbortSignal,
  ): Promise<CollectionItem>;
  removeCollectionItem(
    collectionId: string,
    itemType: 'template' | 'generation',
    itemKey: string,
    signal?: AbortSignal,
  ): Promise<CollectionItemRemoval>;
  /** W04: full private export (favorites/collections/history). Never contains secrets. */
  exportWorkspace(signal?: AbortSignal): Promise<WorkspaceExport>;
}

export function createOnePicClient(options: OnePicClientOptions): OnePicClient {
  return {
    getHealthLive(signal?: AbortSignal): Promise<HealthLive> {
      return request<HealthLive>(options, '/api/v1/health/live', {}, signal);
    },
    getHealthReady(signal?: AbortSignal): Promise<HealthReady> {
      return request<HealthReady>(options, '/api/v1/health/ready', {}, signal);
    },
    getLoginUrl(): string {
      return new URL('/api/v1/auth/login', options.baseUrl).toString();
    },
    getLoginCallbackUrl(code: string, state: string): string {
      return withQuery(new URL('/api/v1/auth/callback', options.baseUrl).toString(), {
        code,
        state,
      });
    },
    getCurrentSubject(signal?: AbortSignal): Promise<AuthMe> {
      return request<AuthMe>(options, '/api/v1/auth/me', {}, signal);
    },
    refreshSession(signal?: AbortSignal): Promise<AuthRefresh> {
      return request<AuthRefresh>(
        options,
        '/api/v1/auth/refresh',
        { method: 'POST', headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    logout(signal?: AbortSignal): Promise<AuthLogout> {
      return request<AuthLogout>(
        options,
        '/api/v1/auth/logout',
        { method: 'POST', headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    getSignedMedia(signedUrl: string, signal?: AbortSignal): Promise<SignedMediaDownload> {
      return requestSignedMedia(options, signedUrl, signal);
    },
    createUpload(input: UploadCreateRequest, signal?: AbortSignal): Promise<UploadSession> {
      return request<UploadSession>(
        options,
        '/api/v1/uploads',
        { method: 'POST', body: input, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    uploadBytes(uploadId: string, body: ArrayBuffer, signal?: AbortSignal): Promise<UploadBytes> {
      return request<UploadBytes>(
        options,
        `/api/v1/uploads/${encodeURIComponent(uploadId)}/bytes`,
        { method: 'PUT', body, binary: true, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    confirmUpload(
      uploadId: string,
      input: UploadConfirmRequest,
      signal?: AbortSignal,
    ): Promise<UploadConfirmed> {
      return request<UploadConfirmed>(
        options,
        `/api/v1/uploads/${encodeURIComponent(uploadId)}/confirm`,
        { method: 'POST', body: input, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    createPrecheck(input: PrecheckCreateRequest, signal?: AbortSignal): Promise<PrecheckCreated> {
      return request<PrecheckCreated>(
        options,
        '/api/v1/prechecks',
        { method: 'POST', body: input, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    createGeneration(
      input: GenerationCreateRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<GenerationStatusEnvelope> {
      return requestEnvelope<GenerationStatusData>(
        options,
        '/api/v1/generations',
        {
          method: 'POST',
          body: input,
          headers: { ...CSRF_HEADER, 'idempotency-key': idempotencyKey },
        },
        signal,
      );
    },
    getGeneration(generationId: string, signal?: AbortSignal): Promise<GenerationStatusEnvelope> {
      return requestEnvelope<GenerationStatusData>(
        options,
        `/api/v1/generations/${encodeURIComponent(generationId)}`,
        {},
        signal,
      );
    },
    getGenerationSidecar(generationId: string, signal?: AbortSignal): Promise<GenerationSidecar> {
      return request<GenerationSidecar>(
        options,
        `/api/v1/generations/${encodeURIComponent(generationId)}/sidecar`,
        {},
        signal,
      );
    },
    cancelGeneration(generationId: string, signal?: AbortSignal): Promise<GenerationCancelResult> {
      return request<GenerationCancelResult>(
        options,
        `/api/v1/generations/${encodeURIComponent(generationId)}/cancel`,
        { method: 'POST', body: {}, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    deleteGeneration(generationId: string, signal?: AbortSignal): Promise<GenerationDeleteResult> {
      return request<GenerationDeleteResult>(
        options,
        `/api/v1/generations/${encodeURIComponent(generationId)}`,
        { method: 'DELETE', headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    listGenerations(
      params: ListGenerationsParams = {},
      signal?: AbortSignal,
    ): Promise<GenerationListEnvelope> {
      return requestEnvelope<GenerationList>(
        options,
        withQuery('/api/v1/generations', {
          state: params.state,
          cursor: params.cursor,
          limit: params.limit,
        }),
        {},
        signal,
      );
    },
    listCollections(
      params: { cursor?: string; limit?: number } = {},
      signal?: AbortSignal,
    ): Promise<CollectionListEnvelope> {
      return requestEnvelope<CollectionList>(
        options,
        withQuery('/api/v1/collections', { cursor: params.cursor, limit: params.limit }),
        {},
        signal,
      );
    },
    createCollection(
      input: CollectionCreateRequest,
      signal?: AbortSignal,
    ): Promise<CollectionSummary> {
      return request<CollectionSummary>(
        options,
        '/api/v1/collections',
        { method: 'POST', body: input, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    deleteCollection(collectionId: string, signal?: AbortSignal): Promise<CollectionDeleted> {
      return request<CollectionDeleted>(
        options,
        `/api/v1/collections/${encodeURIComponent(collectionId)}`,
        { method: 'DELETE', headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    addCollectionItem(
      collectionId: string,
      input: CollectionItemAddRequest,
      signal?: AbortSignal,
    ): Promise<CollectionItem> {
      return request<CollectionItem>(
        options,
        `/api/v1/collections/${encodeURIComponent(collectionId)}/items`,
        { method: 'POST', body: input, headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    removeCollectionItem(
      collectionId: string,
      itemType: 'template' | 'generation',
      itemKey: string,
      signal?: AbortSignal,
    ): Promise<CollectionItemRemoval> {
      return request<CollectionItemRemoval>(
        options,
        `/api/v1/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemKey)}`,
        { method: 'DELETE', headers: { ...CSRF_HEADER } },
        signal,
      );
    },
    exportWorkspace(signal?: AbortSignal): Promise<WorkspaceExport> {
      return request<WorkspaceExport>(options, '/api/v1/exports/workspace', {}, signal);
    },
  };
}

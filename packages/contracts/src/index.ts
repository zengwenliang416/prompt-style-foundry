/**
 * OnePic API contracts shared by the API, worker, and client packages.
 *
 * Single source of truth is the OpenAPI 3.1 document
 * `openapi/api-v1.yaml` (docs/full-stack-architecture.md §6, ADR 0001).
 * `src/generated/api-v1.d.ts` is generated from it via `npm run generate`
 * and must never be hand-edited; the health/envelope types below re-export
 * the generated schemas so every workspace consumes spec-derived types.
 * The compile-time sync guards at the bottom fail `tsc` if the hand-written
 * generic envelope drifts from the generated one.
 *
 * Generation lifecycle states (architecture §9) are TypeScript-only until
 * the generation endpoints join the OpenAPI document (B/J phases):
 * created -> queued -> running -> succeeded
 *                              |-> failed / cancelled / expired / outcome_unknown
 * `expired` is terminal; media expiry never rewrites historical attempt facts.
 */

import type { components } from './generated/api-v1.js';

/** Success envelope: `{ data, meta }` (meta is optional). */
export interface ApiSuccess<TData> {
  data: TData;
  meta?: ApiMeta;
}

/** Free-form paging/tracing metadata carried beside `data`. */
export type ApiMeta = Record<string, unknown>;

/** Error envelope: `{ error: { code, message, details, correlationId } }`. */
export interface ApiFailure {
  error: ApiErrorBody;
}

export interface ApiErrorBody {
  /** Stable machine-readable code; clients must not match on message text. */
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
}

export type HealthLive = components['schemas']['HealthLive'];
export type HealthReady = components['schemas']['HealthReady'];

export { DIRECT_BYOK_CAPABILITIES, RUN_MODES, modelCapabilities } from './provider-capabilities.js';
export type {
  ProviderCapabilities,
  ProviderModelCapabilities,
  RunMode,
} from './provider-capabilities.js';

/** Full generated schema namespace, for consumers wiring runtime validation. */
export type { components };

/**
 * Generation lifecycle states per architecture §9.
 */
export const GENERATION_STATUSES = [
  'created',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'outcome_unknown',
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

// Compile-time sync guards: generated schema types must stay assignable to
// the generic envelopes above (and vice versa) so the hand-written helpers
// and the spec-derived types cannot drift silently. Each guard resolves to
// `true` while they agree and `false` on drift; the const below forces TS to
// evaluate them, so drift fails `tsc` here instead of at a call site.
type GeneratedHealthLiveEnvelope = components['schemas']['ApiSuccessOfHealthLive'];
type GeneratedHealthReadyEnvelope = components['schemas']['ApiSuccessOfHealthReady'];
type SyncGuardLive = ApiSuccess<HealthLive> extends GeneratedHealthLiveEnvelope ? true : false;
type SyncGuardLiveReverse =
  GeneratedHealthLiveEnvelope extends ApiSuccess<HealthLive> ? true : false;
type SyncGuardReady = ApiSuccess<HealthReady> extends GeneratedHealthReadyEnvelope ? true : false;
type SyncGuardReadyReverse =
  GeneratedHealthReadyEnvelope extends ApiSuccess<HealthReady> ? true : false;

const envelopeSyncGuards: [
  SyncGuardLive,
  SyncGuardLiveReverse,
  SyncGuardReady,
  SyncGuardReadyReverse,
] = [true, true, true, true] as const;

void envelopeSyncGuards;

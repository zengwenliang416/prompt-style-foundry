import { computed, getCurrentInstance, onBeforeUnmount, ref } from 'vue';

import { ApiRequestError, createOnePicClient, type OnePicClient } from '@onepic/client';
import type {
  GenerationCreateRequest,
  GenerationStatusData,
  GenerationStatusMeta,
} from '@onepic/contracts';

/**
 * Managed-generation flow (W01/W02): upload → precheck → submit → poll →
 * download against the first-party API, with the failure/unknown/cancel/
 * expiry semantics wired honestly. Guarantees:
 * - exactly one uploaded image per task, no text input (single-image
 *   protocol); aspect stays inherit-only so it is never sent;
 * - double clicks are idempotent: a synchronous busy guard blocks re-entry
 *   and one idempotency key identifies the whole attempt, so a retry after
 *   a lost submit response replays to the SAME server task;
 * - refresh recovery: the in-flight record (MANAGED_INFLIGHT_KEY) is written
 *   BEFORE submit (idempotency key + request body) and updated with the
 *   generation id afterwards; on mount the composable either resumes polling
 *   or re-submits with the SAME key — the server's (owner, key) uniqueness
 *   makes that a replay, never a second task;
 * - outcome_unknown is terminal-but-unresolved: the record is KEPT so a
 *   refresh still shows the honest "result unknown" state; the flow never
 *   retries or re-submits implicitly — only the explicit dismiss clears it;
 * - polling tolerates 429/5xx/network drops with bounded backoff and a
 *   visible notice; 401 clears the record and points at login; 403/404
 *   clear it as unusable;
 * - out-of-order guard: a response whose state rank is lower than the
 *   highest rank already applied is discarded, so a late stale "running"
 *   can never overwrite a terminal state;
 * - the browser BYOK key is never read here — managed requests carry only
 *   the session cookie; provider credentials are server-injected (ADR 0003).
 */

export const MANAGED_INFLIGHT_KEY = 'onepic.managed.inflight.v1';

/** The static catalog carries no per-template version; version 1 is the only
 * imported version and the server re-verifies promptSha256 against it, so a
 * moved catalog fails honestly instead of silently substituting a prompt. */
const STATIC_CATALOG_TEMPLATE_VERSION = 1;

const MANAGED_MODEL = 'gpt-image-2';
const MANAGED_QUALITY = 'high';
const DEFAULT_POLL_MS = 2000;
const MAX_BACKOFF_FACTOR = 5;

export type ManagedPhase =
  | 'idle'
  | 'uploading'
  | 'prechecking'
  | 'submitting'
  | 'polling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'expired';

export interface ManagedResult {
  generationId: string;
  downloadUrl: string;
  actualWidth: number;
  actualHeight: number;
  actualBytes: number;
  sha256: string;
}

interface InflightRecord {
  schemaVersion: 2;
  templateId: string;
  startedAt: string;
  /** Present once the server accepted the task. */
  generationId?: string;
  /** Present while submit has not been confirmed — replay uses the same key. */
  submit?: { idempotencyKey: string; body: GenerationCreateRequest };
}

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }
    void localStorage.length;
    return localStorage;
  } catch {
    return undefined;
  }
}

function isGenerationBody(value: unknown): value is GenerationCreateRequest {
  const raw = value as Partial<GenerationCreateRequest> | null;
  return (
    raw !== null &&
    typeof raw === 'object' &&
    typeof raw.templateId === 'string' &&
    typeof raw.templateVersion === 'number' &&
    typeof raw.promptSha256 === 'string' &&
    typeof raw.sourceObjectId === 'string' &&
    raw.settings !== null &&
    typeof raw.settings === 'object'
  );
}

export function readInflight(): InflightRecord | null {
  const store = storage();
  if (store === undefined) {
    return null;
  }
  try {
    const raw = store.getItem(MANAGED_INFLIGHT_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed['templateId'] !== 'string') {
      return null;
    }
    // v1 records (pre-W02) carried only {generationId, templateId, startedAt}.
    const generationId =
      typeof parsed['generationId'] === 'string' ? parsed['generationId'] : undefined;
    const submitRaw = parsed['submit'] as { idempotencyKey?: unknown; body?: unknown } | undefined;
    const submit =
      submitRaw !== null &&
      typeof submitRaw === 'object' &&
      typeof submitRaw.idempotencyKey === 'string' &&
      isGenerationBody(submitRaw.body)
        ? { idempotencyKey: submitRaw.idempotencyKey, body: submitRaw.body }
        : undefined;
    if (generationId === undefined && submit === undefined) {
      return null;
    }
    return {
      schemaVersion: 2,
      templateId: parsed['templateId'],
      startedAt: typeof parsed['startedAt'] === 'string' ? parsed['startedAt'] : '',
      ...(generationId !== undefined ? { generationId } : {}),
      ...(submit !== undefined ? { submit } : {}),
    };
  } catch {
    return null;
  }
}

function writeInflight(record: InflightRecord): void {
  try {
    storage()?.setItem(MANAGED_INFLIGHT_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable: the flow continues without refresh recovery.
  }
}

export function clearInflight(): void {
  try {
    storage()?.removeItem(MANAGED_INFLIGHT_KEY);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

async function sha256HexOfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Monotonic ranks for the out-of-order guard: a response may never move the
 * observed state backwards (a late "running" must not overwrite a terminal). */
const STATE_RANK: Record<string, number> = {
  created: 1,
  queued: 1,
  running: 2,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
  expired: 3,
  outcome_unknown: 3,
};

/** A poll error worth retrying silently (with backoff), never a failure. */
function isTransientPollError(err: unknown): boolean {
  if (err instanceof ApiRequestError) {
    return err.status === 429 || err.status >= 500;
  }
  // fetch TypeError (offline / DNS / connection reset) and friends.
  return err instanceof TypeError;
}

export interface ManagedGenerationState {
  phase: import('vue').Ref<ManagedPhase>;
  error: import('vue').Ref<string | null>;
  /** Transient, non-fatal notice (backoff, cancel-requested, expiry info). */
  notice: import('vue').Ref<string | null>;
  result: import('vue').Ref<ManagedResult | null>;
  busy: import('vue').Ref<boolean>;
  generationId: import('vue').Ref<string | null>;
  /** True while a cancellable in-flight task exists (polling phase). */
  canCancel: import('vue').ComputedRef<boolean>;
  start: (input: { file: File; templateId: string; promptSha256: string }) => Promise<void>;
  /** Cooperative cancel (J08): queued → cancelled; running → request only. */
  cancel: () => Promise<void>;
  /** Explicit dismissal of an outcome_unknown record — the only way it clears. */
  dismissUnknown: () => void;
  /** Refresh recovery: resume polling or replay an unconfirmed submit. */
  restore: (templateId: string | undefined) => Promise<void>;
  reset: () => void;
}

export interface ManagedGenerationOptions {
  client?: OnePicClient;
  /** Injectable for tests; defaults to setTimeout-driven waits. */
  wait?: (ms: number) => Promise<void>;
}

export function useManagedGeneration(
  options: ManagedGenerationOptions = {},
): ManagedGenerationState {
  const client =
    options.client ??
    createOnePicClient({
      baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    });
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const phase = ref<ManagedPhase>('idle');
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const result = ref<ManagedResult | null>(null);
  const busy = ref(false);
  const generationId = ref<string | null>(null);
  const cancelling = ref(false);

  let activeAttempt = 0;
  let observedRank = 0;

  const canCancel = computed(
    () => generationId.value !== null && phase.value === 'polling' && !cancelling.value,
  );

  function fail(err: unknown): void {
    phase.value = 'failed';
    busy.value = false;
    if (err instanceof ApiRequestError) {
      error.value =
        err.status === 401
          ? '请先登录后再使用受管生成。'
          : `生成请求失败（${err.code}）：${err.message}`;
    } else {
      error.value = '生成请求失败：网络异常；若任务已提交，刷新页面可恢复进度。';
    }
  }

  /**
   * Applies a polled/authoritative status. Returns 'stale' when the response
   * is older than what we already applied (out-of-order guard), 'terminal'
   * when a terminal state was applied, otherwise 'pending'.
   */
  function applyStatus(
    data: GenerationStatusData,
    meta: GenerationStatusMeta | undefined,
  ): 'terminal' | 'pending' | 'stale' {
    const rank = STATE_RANK[data.state] ?? 0;
    if (rank < observedRank) {
      return 'stale';
    }
    observedRank = rank;

    if (data.state === 'succeeded') {
      if (typeof meta?.downloadUrl === 'string' && data.result !== undefined) {
        result.value = {
          generationId: data.id,
          downloadUrl: meta.downloadUrl,
          actualWidth: data.result.actualWidth,
          actualHeight: data.result.actualHeight,
          actualBytes: data.result.actualBytes,
          sha256: data.result.sha256,
        };
      }
      phase.value = 'succeeded';
      busy.value = false;
      clearInflight();
      return 'terminal';
    }
    if (data.state === 'failed') {
      phase.value = 'failed';
      busy.value = false;
      error.value = `任务失败${data.errorCode !== undefined ? `（${data.errorCode}）` : ''}`;
      clearInflight();
      return 'terminal';
    }
    if (data.state === 'cancelled') {
      phase.value = 'cancelled';
      busy.value = false;
      clearInflight();
      return 'terminal';
    }
    if (data.state === 'expired') {
      // Media expiry never rewrites history: the task stays queryable, only
      // the download is gone (J10).
      phase.value = 'expired';
      busy.value = false;
      notice.value = '结果媒体已过期清理，无法下载；任务历史与哈希仍可查询。';
      clearInflight();
      return 'terminal';
    }
    if (data.state === 'outcome_unknown') {
      // Honest unknown: provider may have delivered (and billed). NEVER
      // retry or re-submit implicitly; the inflight record is KEPT so a
      // refresh still lands on this state. Only dismissUnknown() clears it.
      phase.value = 'unknown';
      busy.value = false;
      error.value =
        '结果未知：provider 未确认是否已出图。不会自动重试或重复提交；请稍后到本页刷新查看，或等待对账处置。';
      return 'terminal';
    }
    return 'pending';
  }

  async function poll(id: string, attempt: number): Promise<void> {
    phase.value = 'polling';
    let failures = 0;
    for (;;) {
      if (attempt !== activeAttempt) {
        return;
      }
      let envelope;
      try {
        envelope = await client.getGeneration(id);
      } catch (err) {
        if (attempt !== activeAttempt) {
          return;
        }
        if (
          err instanceof ApiRequestError &&
          (err.status === 401 || err.status === 403 || err.status === 404)
        ) {
          // Session lost / task gone or foreign: the record is unusable.
          clearInflight();
          throw err;
        }
        if (!isTransientPollError(err)) {
          throw err;
        }
        // 429 / 5xx / network drop: never a task failure — back off and keep
        // polling (single in-flight request by construction: the loop awaits
        // each response before scheduling the next).
        failures += 1;
        if (failures >= 2) {
          notice.value = '暂时无法查询任务状态，正在自动重试；已提交的任务不受影响。';
        }
        const base = DEFAULT_POLL_MS;
        await wait(base * Math.min(failures, MAX_BACKOFF_FACTOR));
        continue;
      }
      if (attempt !== activeAttempt) {
        return;
      }
      failures = 0;
      if (notice.value !== null && phase.value === 'polling') {
        notice.value = null;
      }
      const applied = applyStatus(envelope.data, envelope.meta);
      if (applied === 'terminal') {
        return;
      }
      if (applied === 'stale') {
        continue;
      }
      await wait(envelope.meta?.pollAfterMs ?? DEFAULT_POLL_MS);
    }
  }

  function buildRequestBody(input: {
    templateId: string;
    promptSha256: string;
    sourceObjectId: string;
    precheckId: string;
  }): GenerationCreateRequest {
    return {
      templateId: input.templateId,
      templateVersion: STATIC_CATALOG_TEMPLATE_VERSION,
      promptSha256: input.promptSha256,
      sourceObjectId: input.sourceObjectId,
      precheckId: input.precheckId,
      settings: { model: MANAGED_MODEL, quality: MANAGED_QUALITY },
    };
  }

  async function start(input: {
    file: File;
    templateId: string;
    promptSha256: string;
  }): Promise<void> {
    // Synchronous guard: a second click while an attempt is in flight is a
    // no-op — the in-flight idempotency key still identifies the same task.
    if (busy.value) {
      return;
    }
    busy.value = true;
    error.value = null;
    notice.value = null;
    result.value = null;
    const attempt = ++activeAttempt;
    observedRank = 0;

    try {
      phase.value = 'uploading';
      const bytes = await input.file.arrayBuffer();
      const session = await client.createUpload({
        declaredBytes: bytes.byteLength,
        declaredMime: input.file.type as 'image/jpeg' | 'image/png' | 'image/webp',
      });
      await client.uploadBytes(session.uploadId, bytes);
      const confirmed = await client.confirmUpload(session.uploadId, {
        sha256: await sha256HexOfBytes(bytes),
      });

      phase.value = 'prechecking';
      const precheck = await client.createPrecheck({
        templateId: input.templateId,
        templateVersion: STATIC_CATALOG_TEMPLATE_VERSION,
        sourceObjectId: confirmed.mediaObjectId,
        settings: { model: MANAGED_MODEL, quality: MANAGED_QUALITY },
      });

      // Persist BEFORE the submit request: if the response is lost (timeout/
      // network), a refresh replays with the SAME idempotency key — the
      // server returns the same task instead of creating a second one.
      const body = buildRequestBody({
        templateId: input.templateId,
        promptSha256: input.promptSha256,
        sourceObjectId: confirmed.mediaObjectId,
        precheckId: precheck.precheckId,
      });
      const submit = { idempotencyKey: crypto.randomUUID(), body };
      writeInflight({
        schemaVersion: 2,
        templateId: input.templateId,
        startedAt: new Date().toISOString(),
        submit,
      });

      phase.value = 'submitting';
      const submitted = await client.createGeneration(body, submit.idempotencyKey);
      if (attempt !== activeAttempt) {
        return;
      }
      generationId.value = submitted.data.id;
      writeInflight({
        schemaVersion: 2,
        templateId: input.templateId,
        startedAt: new Date().toISOString(),
        generationId: submitted.data.id,
      });
      await poll(submitted.data.id, attempt);
    } catch (err) {
      if (attempt !== activeAttempt) {
        return;
      }
      // Definitive client faults (4xx) make the persisted submit record
      // useless; transient ones (network/5xx/429) keep it so a refresh can
      // replay the same idempotency key.
      if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) {
        clearInflight();
      }
      fail(err);
    }
  }

  async function cancel(): Promise<void> {
    const id = generationId.value;
    if (id === null || cancelling.value) {
      return;
    }
    cancelling.value = true;
    try {
      const outcome = await client.cancelGeneration(id);
      if (outcome.outcome === 'cancelled') {
        // Queued task cancelled server-side: stop polling immediately.
        activeAttempt += 1;
        phase.value = 'cancelled';
        busy.value = false;
        clearInflight();
      } else if (outcome.outcome === 'cancel_requested') {
        // J08 honesty: the provider may already have accepted (and billed)
        // the work; keep polling until the real terminal state arrives.
        notice.value = '已记录取消请求：上游可能已接受任务，不保证免计费；任务仍会走到终态。';
      } else {
        // already_terminal: the server's state is authoritative; applying a
        // terminal state stops the poll loop (stale late responses are then
        // discarded by the rank guard).
        const applied = applyStatus({ state: outcome.state } as GenerationStatusData, undefined);
        if (applied === 'terminal') {
          activeAttempt += 1;
        }
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        notice.value = '结果未知的任务不能通过取消了结，需等待对账或人工处置。';
      } else if (err instanceof ApiRequestError && err.status === 401) {
        clearInflight();
        fail(err);
      } else if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
        clearInflight();
        fail(err);
      } else {
        notice.value = '取消请求失败，请稍后重试。';
      }
    } finally {
      cancelling.value = false;
    }
  }

  function dismissUnknown(): void {
    if (phase.value === 'unknown') {
      clearInflight();
      reset();
    }
  }

  async function restore(templateId: string | undefined): Promise<void> {
    const record = readInflight();
    if (record === null) {
      return;
    }
    if (templateId !== undefined && record.templateId !== templateId) {
      // A different template's page: leave the record untouched for its page.
      return;
    }
    if (busy.value) {
      return;
    }
    busy.value = true;
    error.value = null;
    notice.value = null;
    const attempt = ++activeAttempt;
    observedRank = 0;

    // Submit never confirmed (response lost): replay with the SAME
    // idempotency key. The server replays to the existing task — this is
    // refresh recovery, not a blind retry.
    if (record.generationId === undefined) {
      if (record.submit === undefined) {
        clearInflight();
        busy.value = false;
        return;
      }
      phase.value = 'submitting';
      try {
        const submitted = await client.createGeneration(
          record.submit.body,
          record.submit.idempotencyKey,
        );
        if (attempt !== activeAttempt) {
          return;
        }
        generationId.value = submitted.data.id;
        writeInflight({
          schemaVersion: 2,
          templateId: record.templateId,
          startedAt: record.startedAt,
          generationId: submitted.data.id,
        });
        await poll(submitted.data.id, attempt);
      } catch (err) {
        if (attempt !== activeAttempt) {
          return;
        }
        if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) {
          clearInflight();
        }
        fail(err);
      }
      return;
    }

    generationId.value = record.generationId;
    try {
      const envelope = await client.getGeneration(record.generationId);
      if (attempt !== activeAttempt) {
        return;
      }
      if (applyStatus(envelope.data, envelope.meta) === 'terminal') {
        return;
      }
      await poll(record.generationId, attempt);
    } catch (err) {
      if (attempt !== activeAttempt) {
        return;
      }
      // Gone, foreign (new login), or logged out: the record is useless.
      if (
        err instanceof ApiRequestError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      ) {
        clearInflight();
      }
      fail(err);
    }
  }

  function reset(): void {
    activeAttempt += 1;
    observedRank = 0;
    phase.value = 'idle';
    error.value = null;
    notice.value = null;
    result.value = null;
    busy.value = false;
    generationId.value = null;
  }

  if (getCurrentInstance() !== null) {
    onBeforeUnmount(() => {
      // Invalidate in-flight polls so an unmounted page stops writing state.
      activeAttempt += 1;
    });
  }

  return {
    phase,
    error,
    notice,
    result,
    busy,
    generationId,
    canCancel,
    start,
    cancel,
    dismissUnknown,
    restore,
    reset,
  };
}

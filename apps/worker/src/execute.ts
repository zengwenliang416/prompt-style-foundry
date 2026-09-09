import { createHash } from 'node:crypto';

import { deadLetterJob, markGenerationOutcomeUnknown } from './reconcile.js';
import { failJob } from './queue.js';
import { classifyProviderFailure } from './retry-policy.js';

/** Structural query interface satisfied by pg Client/Pool/PoolClient. */
interface Queryable {
  query<R extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Structural provider port — the real adapter comes from @onepic/api. */
interface ProviderLike {
  generate(request: {
    model: string;
    quality: string;
    prompt: string;
    inputImage: Buffer;
    inputMime: string;
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; value: { imageBytes: Buffer; rawBody: Buffer } }
    | { ok: false; code: string; status?: number; message: string; requestId?: string }
  >;
}

interface StorageLike {
  get(input: { bucket: string; key: string }): Promise<Buffer>;
  put(input: { bucket: string; key: string; body: Buffer }): Promise<void>;
}

/**
 * J09 result-validation port — structurally satisfied by the api module's
 * validateImage (M02): magic bytes, real decode, byte/pixel ceilings.
 */
interface ImageValidator {
  (bytes: Buffer): Promise<
    | {
        ok: true;
        value: { mime: string; bytes: number; width: number; height: number; orientation: number };
      }
    | { ok: false; code: string; message: string }
  >;
}

/**
 * Claimed-job execution with full send traceability (J05, architecture §7)
 * and result verification (J09):
 * - the sent prompt is the immutable template_version.snapshot text, verbatim;
 * - if the stored snapshot hash differs from compiled_prompt_sha256 the job
 *   FAILS without sending anything (template/body substitution refused);
 * - the attempt row records the exact sent prompt hash, parameters, and
 *   provider state so upstream request bytes can be reconciled (mock provider
 *   recorded bodies must hash-match the attempt);
 * - provider result bytes are validated (fake MIME / oversized / missing
 *   image are REJECTED — a paid call is never retried for garbage) and the
 *   result row records ACTUAL decoded mime/bytes/dimensions, separately from
 *   whatever was requested;
 * - a storage failure after a successful provider call dead-letters WITHOUT
 *   retry — the paid model is never re-called to work around local storage.
 */

export interface ExecutionDeps {
  db: Queryable;
  adapter: ProviderLike;
  storage: StorageLike;
  validateImage: ImageValidator;
  providerId: string;
  abortSignal?: AbortSignal;
  onProviderRequestStarted?: (context: {
    jobId: string;
    generationId: string;
    attemptId: string;
  }) => void;
}

export interface ExecutionContext {
  jobId: string;
  workerId: string;
  generationId: string;
}

export type ExecutionOutcome =
  | { ok: true; sentPromptSha256: string }
  | {
      ok: false;
      refused: boolean;
      errorCode: string;
      sentPromptSha256: string | null;
      /** J07: the job was returned to the pending queue for a bounded retry. */
      retried?: boolean;
    };

export async function executeClaimedJob(
  deps: ExecutionDeps,
  context: ExecutionContext,
): Promise<ExecutionOutcome> {
  const { db } = deps;
  const generation = await db.query<{
    input_object_id: string;
    input_sha256: string;
    template_version_id: string;
    provider_id: string;
    model: string;
    settings: Record<string, unknown>;
    state: string;
    cancel_requested_at: string | null;
  }>(
    'SELECT input_object_id, input_sha256, template_version_id, provider_id, model, settings, state, cancel_requested_at FROM generation WHERE id = $1',
    [context.generationId],
  );
  const generationRow = generation.rows[0];
  if (generationRow === undefined) {
    return refuseExecution(deps, context, 'GENERATION_STATE_ILLEGAL');
  }

  if (generationRow.provider_id !== deps.providerId) {
    return refuseExecution(deps, context, 'PROVIDER_NOT_ALLOWLISTED');
  }
  const version = await db.query<{
    prompt_text: string | null;
    compiled_prompt_sha256: string;
    metadata: Record<string, unknown>;
  }>('SELECT prompt_text, compiled_prompt_sha256, metadata FROM template_version WHERE id = $1', [
    generationRow.template_version_id,
  ]);
  const versionRow = version.rows[0];
  if (versionRow === undefined || versionRow.prompt_text === null) {
    return refuseExecution(deps, context, 'INTERNAL');
  }

  // Substitution guard: the snapshot text must hash exactly to the immutable
  // compiled prompt hash. Any drift means someone tampered with the snapshot.
  const snapshotSha = createHash('sha256')
    .update(versionRow.prompt_text.replace(/\n+$/, ''))
    .digest('hex');
  if (snapshotSha !== versionRow.compiled_prompt_sha256) {
    return refuseExecution(deps, context, 'PROMPT_REWRITE_BLOCKED');
  }

  // J08: a recorded cancel request is honoured BEFORE anything is sent —
  // never billed, so the reservation is released and no attempt row exists
  // (an attempt would falsely claim bytes went upstream).
  if (generationRow.cancel_requested_at !== null) {
    const cancelled = await db.query(
      `UPDATE generation SET state = 'cancelled', completed_at = now(), updated_at = now()
       WHERE id = $1 AND state IN ('queued', 'running') AND cancel_requested_at IS NOT NULL`,
      [context.generationId],
    );
    if ((cancelled.rowCount ?? 0) > 0) {
      await db.query(
        `INSERT INTO quota_ledger (subject_id, generation_id, delta, reason)
         SELECT owner_id, id, +1, 'release' FROM generation WHERE id = $1
         ON CONFLICT (generation_id, reason) DO NOTHING`,
        [context.generationId],
      );
    }
    await deadLetterJob(db, {
      jobId: context.jobId,
      workerId: context.workerId,
      reason: 'cancelled',
    });
    return { ok: false, refused: false, errorCode: 'CANCELLED', sentPromptSha256: null };
  }

  // J08: advertise the honest running state (CAS). A retry of the same job
  // finds the row already running — still ours, the lease guarantees a single
  // executor. Zero rows means a queued-cancel (or terminal transition) won
  // the race — send nothing and bury the job.
  const markedRunning = await db.query(
    `UPDATE generation SET state = 'running', updated_at = now() WHERE id = $1 AND state IN ('queued', 'running')`,
    [context.generationId],
  );
  if ((markedRunning.rowCount ?? 0) === 0) {
    const current = await db.query<{ state: string }>(
      'SELECT state FROM generation WHERE id = $1',
      [context.generationId],
    );
    const raced = current.rows[0]?.state === 'cancelled';
    await deadLetterJob(db, {
      jobId: context.jobId,
      workerId: context.workerId,
      reason: raced ? 'cancelled' : 'GENERATION_STATE_ILLEGAL',
    });
    return {
      ok: false,
      refused: !raced,
      errorCode: raced ? 'CANCELLED' : 'GENERATION_STATE_ILLEGAL',
      sentPromptSha256: null,
    };
  }

  // Effective prompt equals compiled prompt by default (§7); there is no
  // runtime rewrite path.
  const effectivePrompt = versionRow.prompt_text;
  const effectiveSha = createHash('sha256')
    .update(effectivePrompt.replace(/\n+$/, ''))
    .digest('hex');

  const attemptNo = (
    await db.query<{ next: number }>(
      'SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM attempt WHERE generation_id = $1',
      [context.generationId],
    )
  ).rows[0]!.next;

  const inputBytes = await deps.storage.get({
    bucket: 'quarantine',
    key: await inputObjectKey(db, generationRow.input_object_id),
  });

  // Record the attempt BEFORE the provider call (state=sent) with the exact
  // hash of what will be sent.
  const attempt = await db.query<{ id: string }>(
    `INSERT INTO attempt (generation_id, attempt_no, sent_prompt_sha256, state)
     VALUES ($1, $2, $3, 'sent') RETURNING id`,
    [context.generationId, attemptNo, effectiveSha],
  );
  const attemptId = attempt.rows[0]!.id;

  const request = {
    model: generationRow.model,
    quality:
      typeof generationRow.settings['quality'] === 'string'
        ? (generationRow.settings['quality'] as string)
        : 'high',
    prompt: effectivePrompt,
    inputImage: inputBytes,
    inputMime: 'image/png',
    ...(deps.abortSignal === undefined ? {} : { signal: deps.abortSignal }),
  };

  deps.onProviderRequestStarted?.({
    jobId: context.jobId,
    generationId: context.generationId,
    attemptId,
  });

  let outcome;
  try {
    outcome = await deps.adapter.generate(request);
  } catch {
    // J06: connection interrupted after send — never retried, never failed;
    // the generation goes outcome_unknown and waits for explicit disposition.
    await db.query(`UPDATE attempt SET state = 'unknown', finished_at = now() WHERE id = $1`, [
      attemptId,
    ]);
    await markGenerationOutcomeUnknown(db, {
      generationId: context.generationId,
      attemptId,
    });
    await deadLetterJob(db, {
      jobId: context.jobId,
      workerId: context.workerId,
      reason: 'PROVIDER_TIMEOUT_UNKNOWN',
    });
    return {
      ok: false,
      refused: false,
      errorCode: 'PROVIDER_TIMEOUT_UNKNOWN',
      sentPromptSha256: effectiveSha,
    };
  }

  if (!outcome.ok) {
    if (outcome.code === 'PROVIDER_TIMEOUT_UNKNOWN') {
      // J06: timeout / interrupted request (adapter-normalized). Record any
      // provider request ID the timeout response carried as reconciliation
      // evidence, then move generation → outcome_unknown and dead-letter the
      // job so no worker can re-send automatically.
      await db.query(
        `UPDATE attempt SET state = 'unknown', error_code = $2, provider_request_id = COALESCE($3, provider_request_id), finished_at = now() WHERE id = $1`,
        [attemptId, outcome.code, outcome.requestId ?? null],
      );
      await markGenerationOutcomeUnknown(db, {
        generationId: context.generationId,
        attemptId,
        requestId: outcome.requestId,
      });
      await deadLetterJob(db, {
        jobId: context.jobId,
        workerId: context.workerId,
        reason: 'PROVIDER_TIMEOUT_UNKNOWN',
      });
      return { ok: false, refused: false, errorCode: outcome.code, sentPromptSha256: effectiveSha };
    }
    // J07: classify the failure — 401/参数错误 never retry; 429/503/5xx
    // retry only with provider evidence (Retry-After) on this non-idempotent
    // path; failJob enforces the attempts bound and dead-letters when
    // exhausted (generation → failed only when the job actually dies).
    await db.query(
      `UPDATE attempt SET state = 'failed', error_code = $2, http_status = $3, finished_at = now() WHERE id = $1`,
      [attemptId, outcome.code, outcome.status ?? null],
    );
    const verdict = classifyProviderFailure(outcome, { idempotencySafe: false });
    const failure = await failJob(db, {
      jobId: context.jobId,
      workerId: context.workerId,
      generationId: context.generationId,
      reason: outcome.code,
      retryable: verdict.retryable,
      retryDelaySeconds: verdict.retryDelaySeconds,
    });
    return {
      ok: false,
      refused: false,
      errorCode: outcome.code,
      sentPromptSha256: effectiveSha,
      retried: failure.retried,
    };
  }

  await db.query(`UPDATE attempt SET state = 'succeeded', finished_at = now() WHERE id = $1`, [
    attemptId,
  ]);

  // J09: verify what the provider actually returned BEFORE storing — fake
  // MIME, undecodable payloads, and size/pixel overflows are rejected and the
  // job dead-letters (retrying garbage would re-bill for the same garbage).
  const validation = await deps.validateImage(outcome.value.imageBytes);
  if (!validation.ok) {
    await db.query(`UPDATE attempt SET error_code = $2 WHERE id = $1`, [
      attemptId,
      validation.code,
    ]);
    await failJob(db, {
      jobId: context.jobId,
      workerId: context.workerId,
      generationId: context.generationId,
      reason: validation.code,
      retryable: false,
    });
    return {
      ok: false,
      refused: false,
      errorCode: validation.code,
      sentPromptSha256: effectiveSha,
      retried: false,
    };
  }
  const actual = validation.value;

  // Result storage: provider bytes go to the private bucket with measured
  // hash. A storage failure here must NEVER re-call the paid model — the
  // attempt stays 'succeeded' (the provider did deliver), the generation
  // fails with RESULT_STORAGE_FAILED, and the job dead-letters.
  const resultSha = createHash('sha256').update(outcome.value.imageBytes).digest('hex');
  const extension = actual.mime === 'image/jpeg' ? 'jpg' : (actual.mime.split('/')[1] ?? 'bin');
  const resultKey = `results/${context.generationId}.${extension}`;
  try {
    await deps.storage.put({ bucket: 'private', key: resultKey, body: outcome.value.imageBytes });
  } catch {
    await db.query(`UPDATE attempt SET error_code = 'RESULT_STORAGE_FAILED' WHERE id = $1`, [
      attemptId,
    ]);
    await failJob(db, {
      jobId: context.jobId,
      workerId: context.workerId,
      generationId: context.generationId,
      reason: 'RESULT_STORAGE_FAILED',
      retryable: false,
    });
    return {
      ok: false,
      refused: false,
      errorCode: 'RESULT_STORAGE_FAILED',
      sentPromptSha256: effectiveSha,
      retried: false,
    };
  }
  const media = await db.query<{ id: string }>(
    `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, mime, bytes, width, height, sha256, expires_at)
     SELECT owner_id, 'result', 'ready', 'private', $2, $3, $4, $5, $6, $7, now() + interval '7 days'
     FROM generation WHERE id = $1 RETURNING id`,
    [
      context.generationId,
      resultKey,
      actual.mime,
      actual.bytes,
      actual.width,
      actual.height,
      resultSha,
    ],
  );
  const resultMediaId = media.rows[0]!.id;
  await db.query(
    `INSERT INTO result (generation_id, attempt_id, media_object_id, actual_mime, actual_bytes, actual_width, actual_height)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (generation_id) DO NOTHING`,
    [
      context.generationId,
      attemptId,
      resultMediaId,
      actual.mime,
      actual.bytes,
      actual.width,
      actual.height,
    ],
  );

  void versionRow.metadata;
  return { ok: true, sentPromptSha256: effectiveSha };
}

/**
 * J07 failure archival for refused executions: a refused job must NOT stay
 * leased/pending forever (lease-expiry reclaim would otherwise loop it until
 * attempts exhaust with a misleading reason). It dead-letters immediately
 * with the refusal code and fails the generation.
 */
async function refuseExecution(
  deps: ExecutionDeps,
  context: ExecutionContext,
  errorCode: string,
): Promise<ExecutionOutcome> {
  await failJob(deps.db, {
    jobId: context.jobId,
    workerId: context.workerId,
    generationId: context.generationId,
    reason: errorCode,
    retryable: false,
  });
  return { ok: false, refused: true, errorCode, sentPromptSha256: null };
}

async function inputObjectKey(db: Queryable, mediaObjectId: string): Promise<string> {
  const row = await db.query<{ object_key: string }>(
    'SELECT object_key FROM media_object WHERE id = $1',
    [mediaObjectId],
  );
  return row.rows[0]!.object_key;
}

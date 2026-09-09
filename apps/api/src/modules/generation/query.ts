import type { Queryable } from '../../db/queryable.js';
import { signMediaPath } from '../media/signed-access.js';

/**
 * Generation query / download / sidecar (J10, data dictionary §4).
 *
 * Guarantees (acceptance):
 * - object-level authorization: a subject reads ONLY its own generations
 *   (cross-user → FORBIDDEN, missing → NOT_FOUND);
 * - correspondence is explicit: the response ties together compiled/effective
 *   prompt hashes, the template key+version, the input image hash, per-attempt
 *   sent hashes/status, and the result's actual decoded metadata + sha256;
 * - expired media never rewrites history: an expired/missing result object
 *   leaves state/attempt/hash facts intact and simply yields no download URL;
 * - the sidecar contains hashes and metadata only — never prompt bodies,
 *   provider credentials, or signing material.
 */

export interface AttemptSummary {
  attemptNo: number;
  state: string;
  errorCode: string | null;
  httpStatus: number | null;
  sentPromptSha256: string;
  providerRequestId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ResultSummary {
  /** Result media object id (contract: generation-status-response result.objectId). */
  objectId: string;
  actualMime: string;
  actualBytes: number;
  actualWidth: number;
  actualHeight: number;
  sha256: string;
  mediaState: string;
  /** true when the media is past expiry or marked expired/deleted. */
  mediaExpired: boolean;
}

export interface GenerationDetail {
  generationId: string;
  state: string;
  errorCode: string | null;
  providerId: string;
  model: string;
  cancelRequested: boolean;
  createdAt: string;
  completedAt: string | null;
  templateKey: string;
  templateVersion: number;
  compiledPromptSha256: string;
  effectivePromptSha256: string;
  inputSha256: string;
  attempts: AttemptSummary[];
  result: ResultSummary | null;
  /** Short-lived signed URL — present only when the result media is live. */
  downloadUrl: string | null;
  downloadExpires: number | null;
}

export interface GenerationSidecar {
  schemaVersion: '1.0.0';
  kind: 'onepic-generation-sidecar';
  generationId: string;
  state: string;
  template: { key: string; version: number };
  prompt: { compiledSha256: string; effectiveSha256: string };
  input: { sha256: string };
  attempts: Array<{
    attemptNo: number;
    state: string;
    errorCode: string | null;
    httpStatus: number | null;
    sentPromptSha256: string;
    providerRequestId: string | null;
  }>;
  result: {
    sha256: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    mediaState: string;
    mediaExpired: boolean;
  } | null;
  createdAt: string;
  completedAt: string | null;
}

export type GenerationQueryResult =
  { ok: true; value: GenerationDetail } | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' };

export class GenerationQueryService {
  constructor(
    private readonly db: Queryable,
    private readonly config: { signingKey: string; downloadTtlSeconds: number },
  ) {}

  async getGeneration(input: {
    generationId: string;
    subjectId: string;
  }): Promise<GenerationQueryResult> {
    const row = (
      await this.db.query<{
        owner_id: string;
        state: string;
        error_code: string | null;
        provider_id: string;
        model: string;
        cancel_requested_at: string | null;
        created_at: string;
        completed_at: string | null;
        compiled_prompt_sha256: string;
        effective_prompt_sha256: string;
        input_sha256: string;
        template_key: string;
        version: number;
      }>(
        `SELECT g.owner_id, g.state, g.error_code, g.provider_id, g.model, g.cancel_requested_at,
                g.created_at, g.completed_at, g.compiled_prompt_sha256, g.effective_prompt_sha256,
                g.input_sha256, tv.template_key, tv.version
         FROM generation g JOIN template_version tv ON tv.id = g.template_version_id
         WHERE g.id = $1`,
        [input.generationId],
      )
    ).rows[0];
    if (row === undefined) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (row.owner_id !== input.subjectId) {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const attempts = (
      await this.db.query<{
        attempt_no: number;
        state: string;
        error_code: string | null;
        http_status: number | null;
        sent_prompt_sha256: string;
        provider_request_id: string | null;
        started_at: string;
        finished_at: string | null;
      }>(
        `SELECT attempt_no, state, error_code, http_status, sent_prompt_sha256, provider_request_id,
                started_at, finished_at
         FROM attempt WHERE generation_id = $1 ORDER BY attempt_no`,
        [input.generationId],
      )
    ).rows.map<AttemptSummary>((a) => ({
      attemptNo: a.attempt_no,
      state: a.state,
      errorCode: a.error_code,
      httpStatus: a.http_status,
      sentPromptSha256: a.sent_prompt_sha256,
      providerRequestId: a.provider_request_id,
      startedAt: new Date(a.started_at).toISOString(),
      finishedAt: a.finished_at === null ? null : new Date(a.finished_at).toISOString(),
    }));

    const resultRow = (
      await this.db.query<{
        media_object_id: string;
        actual_mime: string;
        actual_bytes: string;
        actual_width: number;
        actual_height: number;
        media_state: string;
        media_expires_at: string;
        bucket: string;
        object_key: string;
        sha256: string;
      }>(
        `SELECT r.media_object_id, r.actual_mime, r.actual_bytes::text, r.actual_width, r.actual_height,
                m.state AS media_state, m.expires_at AS media_expires_at, m.bucket, m.object_key, m.sha256
         FROM result r JOIN media_object m ON m.id = r.media_object_id
         WHERE r.generation_id = $1`,
        [input.generationId],
      )
    ).rows[0];

    let result: ResultSummary | null = null;
    let downloadUrl: string | null = null;
    let downloadExpires: number | null = null;
    if (resultRow !== undefined) {
      const expired =
        resultRow.media_state === 'expired' ||
        resultRow.media_state === 'deleted' ||
        new Date(resultRow.media_expires_at).getTime() <= Date.now();
      // Expiry NEVER rewrites the historical success: actual metadata and
      // hashes are returned regardless; only the download goes away.
      result = {
        objectId: resultRow.media_object_id,
        actualMime: resultRow.actual_mime,
        actualBytes: Number(resultRow.actual_bytes),
        actualWidth: resultRow.actual_width,
        actualHeight: resultRow.actual_height,
        sha256: resultRow.sha256,
        mediaState: resultRow.media_state,
        mediaExpired: expired,
      };
      if (!expired) {
        const signed = signMediaPath(
          {
            bucket: resultRow.bucket,
            key: resultRow.object_key,
            ownerId: row.owner_id,
            method: 'GET',
            ttlSeconds: this.config.downloadTtlSeconds,
          },
          this.config.signingKey,
        );
        downloadUrl = signed.path;
        downloadExpires = signed.expires;
      }
    }

    return {
      ok: true,
      value: {
        generationId: input.generationId,
        state: row.state,
        errorCode: row.error_code,
        providerId: row.provider_id,
        model: row.model,
        cancelRequested: row.cancel_requested_at !== null,
        createdAt: new Date(row.created_at).toISOString(),
        completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
        templateKey: row.template_key,
        templateVersion: row.version,
        compiledPromptSha256: row.compiled_prompt_sha256,
        effectivePromptSha256: row.effective_prompt_sha256,
        inputSha256: row.input_sha256,
        attempts,
        result,
        downloadUrl,
        downloadExpires,
      },
    };
  }

  /** Traceability sidecar: hashes + metadata only, no prompt body, no keys. */
  async getSidecar(input: {
    generationId: string;
    subjectId: string;
  }): Promise<
    { ok: true; value: GenerationSidecar } | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' }
  > {
    const detail = await this.getGeneration(input);
    if (!detail.ok) {
      return detail;
    }
    const d = detail.value;
    return {
      ok: true,
      value: {
        schemaVersion: '1.0.0',
        kind: 'onepic-generation-sidecar',
        generationId: d.generationId,
        state: d.state,
        template: { key: d.templateKey, version: d.templateVersion },
        prompt: {
          compiledSha256: d.compiledPromptSha256,
          effectiveSha256: d.effectivePromptSha256,
        },
        input: { sha256: d.inputSha256 },
        attempts: d.attempts.map((a) => ({
          attemptNo: a.attemptNo,
          state: a.state,
          errorCode: a.errorCode,
          httpStatus: a.httpStatus,
          sentPromptSha256: a.sentPromptSha256,
          providerRequestId: a.providerRequestId,
        })),
        result:
          d.result === null
            ? null
            : {
                sha256: d.result.sha256,
                mime: d.result.actualMime,
                bytes: d.result.actualBytes,
                width: d.result.actualWidth,
                height: d.result.actualHeight,
                mediaState: d.result.mediaState,
                mediaExpired: d.result.mediaExpired,
              },
        createdAt: d.createdAt,
        completedAt: d.completedAt,
      },
    };
  }
}

import { randomUUID } from 'node:crypto';

import { modelCapabilities, DIRECT_BYOK_CAPABILITIES } from '@onepic/contracts';

import type { Queryable } from '../../db/queryable.js';
import type { StoragePort } from '../../infra/storage/storage.js';
import { validateImage } from './validate-image.js';

/**
 * Precheck (M04, data dictionary §1.7): validates template/version/single-
 * image/settings/protocol/provider capability BEFORE a generation may be
 * created. Failures are recorded with stable error codes; prechecks expire
 * (1h default); bypassing precheck, reusing an expired one, or swapping the
 * input object afterwards is impossible because the generation creation
 * re-validates the exact precheck row (J01).
 */

export const PRECHECK_TTL_SECONDS = 60 * 60;

export interface PrecheckInput {
  subjectId: string;
  templateKey: string;
  version: number;
  mediaObjectId: string;
  settings: { model?: string; quality?: string; aspect?: string; prompt?: string; effectivePrompt?: string };
}

export type PrecheckProblem =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'TEMPLATE_VERSION_MISMATCH'
  | 'QUARANTINE_NOT_READY'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'PIXEL_LIMIT_EXCEEDED'
  | 'MALFORMED_IMAGE'
  | 'VALIDATION_FAILED'
  | 'PROMPT_REWRITE_BLOCKED';

export type PrecheckOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; problem: PrecheckProblem; message: string };

export class PrecheckService {
  constructor(
    private readonly client: Queryable,
    private readonly storage: StoragePort,
  ) {}

  /**
   * M02 application point: decodes the quarantine bytes and promotes the
   * object to ready with measured values. Only confirmed uploads may be
   * promoted (M01).
   */
  async promoteToReady(input: {
    mediaObjectId: string;
    ownerId: string;
  }): Promise<PrecheckOutcome<{ mime: string; width: number; height: number }>> {
    const media = await this.client.query<{
      owner_id: string;
      state: string;
      bucket: string;
      object_key: string;
      confirmed: boolean;
    }>(
      `SELECT m.owner_id, m.state, m.bucket, m.object_key, (u.confirmed_at IS NOT NULL) AS confirmed
       FROM media_object m LEFT JOIN upload u ON u.media_object_id = m.id
       WHERE m.id = $1`,
      [input.mediaObjectId],
    );
    const row = media.rows[0];
    if (row === undefined || row.owner_id !== input.ownerId) {
      return { ok: false, problem: 'NOT_FOUND', message: 'media object not accessible' };
    }
    if (row.state !== 'quarantine' && row.state !== 'ready') {
      return { ok: false, problem: 'QUARANTINE_NOT_READY', message: `state is ${row.state}` };
    }
    if (!row.confirmed) {
      return { ok: false, problem: 'QUARANTINE_NOT_READY', message: 'upload is not confirmed' };
    }
    if (row.state === 'ready') {
      const existing = await this.client.query<{ mime: string; width: number; height: number }>(
        'SELECT mime, width, height FROM media_object WHERE id = $1',
        [input.mediaObjectId],
      );
      const values = existing.rows[0]!;
      return { ok: true, value: { mime: values.mime ?? '', width: values.width ?? 0, height: values.height ?? 0 } };
    }

    const bytes = await this.storage.get({ bucket: row.bucket, key: row.object_key });
    const validation = await validateImage(bytes, { declaredMime: undefined });
    if (!validation.ok) {
      await this.client.query(`UPDATE media_object SET state = 'rejected' WHERE id = $1`, [
        input.mediaObjectId,
      ]);
      return { ok: false, problem: validation.code, message: validation.message };
    }
    await this.client.query(
      `UPDATE media_object SET state = 'ready', mime = $2, bytes = $3, width = $4, height = $5 WHERE id = $1`,
      [input.mediaObjectId, validation.value.mime, validation.value.bytes, validation.value.width, validation.value.height],
    );
    return {
      ok: true,
      value: { mime: validation.value.mime, width: validation.value.width, height: validation.value.height },
    };
  }

  async createPrecheck(input: PrecheckInput): Promise<
    PrecheckOutcome<{ precheckId: string; expiresAt: Date }>
  > {
    // 1. Protocol: no prompt rewriting through settings (M05 guard).
    if (input.settings.prompt !== undefined || input.settings.effectivePrompt !== undefined) {
      await this.recordFailed(input, 'PROMPT_REWRITE_BLOCKED', 'settings contain prompt text');
      return {
        ok: false,
        problem: 'PROMPT_REWRITE_BLOCKED',
        message: 'prompt text must come from the immutable template version',
      };
    }

    // 2. Template version must exist (imported via B02) — no browser override.
    const version = await this.client.query<{ id: string; compiled_prompt_sha256: string }>(
      'SELECT id, compiled_prompt_sha256 FROM template_version WHERE template_key = $1 AND version = $2',
      [input.templateKey, input.version],
    );
    if (version.rows.length === 0) {
      return {
        ok: false,
        problem: 'TEMPLATE_VERSION_MISMATCH',
        message: `template ${input.templateKey}@${input.version} is not in the imported catalog`,
      };
    }
    const versionId = version.rows[0]!.id;

    // 3. Media: owner-scoped, confirmed, really decoded (M02) and ready.
    const ready = await this.promoteToReady({ mediaObjectId: input.mediaObjectId, ownerId: input.subjectId });
    if (!ready.ok) {
      await this.recordFailed(input, ready.problem, ready.message);
      return ready;
    }

    // 4. Capability-driven settings (no hardcoding): model/quality must be
    // declared by the provider capability registry; aspect is inherit-only.
    const model = input.settings.model ?? DIRECT_BYOK_CAPABILITIES.models[0]?.id ?? '';
    const capabilities = modelCapabilities(DIRECT_BYOK_CAPABILITIES, model);
    if (capabilities === undefined) {
      await this.recordFailed(input, 'VALIDATION_FAILED', 'unknown model');
      return { ok: false, problem: 'VALIDATION_FAILED', message: 'unknown model' };
    }
    const quality = input.settings.quality ?? capabilities.qualities[0] ?? '';
    if (quality !== '' && !capabilities.qualities.includes(quality)) {
      await this.recordFailed(input, 'VALIDATION_FAILED', 'quality not supported by model');
      return { ok: false, problem: 'VALIDATION_FAILED', message: 'quality not supported by model' };
    }
    if (input.settings.aspect !== undefined && input.settings.aspect !== 'inherit') {
      await this.recordFailed(input, 'VALIDATION_FAILED', 'aspect must be inherit (single-image protocol)');
      return { ok: false, problem: 'VALIDATION_FAILED', message: 'aspect must be inherit (single-image protocol)' };
    }

    const settings = { model, quality, aspect: 'inherit' };
    const precheckId = randomUUID();
    const inserted = await this.client.query<{ expires_at: Date }>(
      `INSERT INTO precheck (id, subject_id, media_object_id, template_version_id, settings, result, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'passed', now() + make_interval(secs => $6))
       RETURNING expires_at`,
      [precheckId, input.subjectId, input.mediaObjectId, versionId, JSON.stringify(settings), PRECHECK_TTL_SECONDS],
    );
    return { ok: true, value: { precheckId, expiresAt: inserted.rows[0]!.expires_at } };
  }

  /**
   * Generation-creation gate (J01 calls this): the precheck must be passed,
   * unexpired, owned by the subject, and bound to the exact template version
   * and input object — substituting either is rejected.
   */
  async validateForGeneration(input: {
    precheckId: string;
    subjectId: string;
    templateVersionId: string;
    inputObjectId: string;
  }): Promise<PrecheckOutcome<{ settings: Record<string, unknown> }>> {
    const result = await this.client.query<{
      subject_id: string;
      template_version_id: string;
      media_object_id: string;
      result: string;
      expires_at: Date;
      settings: Record<string, unknown>;
    }>(
      'SELECT subject_id, template_version_id, media_object_id, result, expires_at, settings FROM precheck WHERE id = $1',
      [input.precheckId],
    );
    const row = result.rows[0];
    if (row === undefined || row.subject_id !== input.subjectId) {
      return { ok: false, problem: 'NOT_FOUND', message: 'precheck not accessible' };
    }
    if (row.result !== 'passed') {
      return { ok: false, problem: 'VALIDATION_FAILED', message: 'precheck did not pass' };
    }
    if (row.expires_at.getTime() < Date.now()) {
      return { ok: false, problem: 'VALIDATION_FAILED', message: 'precheck expired' };
    }
    if (row.template_version_id !== input.templateVersionId) {
      return { ok: false, problem: 'TEMPLATE_VERSION_MISMATCH', message: 'template version differs from precheck' };
    }
    if (row.media_object_id !== input.inputObjectId) {
      return { ok: false, problem: 'VALIDATION_FAILED', message: 'input object differs from precheck' };
    }
    return { ok: true, value: { settings: row.settings } };
  }

  private async recordFailed(input: PrecheckInput, errorCode: string, detail: string): Promise<void> {
    // Failed prechecks are recorded for auditability when the referenced
    // objects themselves exist; otherwise the failure stays client-side.
    try {
      await this.client.query(
        `INSERT INTO precheck (id, subject_id, media_object_id, template_version_id, settings, result, error_code, error_detail, expires_at)
         SELECT $1, $2, m.id, tv.id, $3, 'failed', $4, $5, now() + make_interval(secs => $6)
         FROM media_object m
         LEFT JOIN template_version tv ON tv.template_key = $7 AND tv.version = $8
         WHERE m.id = $9`,
        [
          randomUUID(),
          input.subjectId,
          JSON.stringify(input.settings),
          errorCode,
          detail,
          PRECHECK_TTL_SECONDS,
          input.templateKey,
          input.version,
          input.mediaObjectId,
        ],
      );
    } catch {
      // Referenced rows missing entirely: nothing to record server-side.
    }
  }
}

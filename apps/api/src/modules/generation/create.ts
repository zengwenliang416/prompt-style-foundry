import { createHash, randomUUID } from 'node:crypto';

import type { Queryable } from '../../db/queryable.js';
import { QuotaService } from '../quota/service.js';

/**
 * Generation creation (J01/J02, architecture §6/§9):
 * - idempotency: (owner_id, idempotency_key) unique — the same key with the
 *   same request fingerprint returns the SAME task; a different fingerprint
 *   under the same key is an IDEMPOTENCY_CONFLICT (409 semantics);
 * - atomicity (J02): generation + queue job are written in ONE transaction —
 *   any failure rolls back leaving no half-created task;
 * - quota: the reservation happens in the same transaction against the now-
 *   known generation id; the ledger's (generation_id, reason) uniqueness and
 *   the task-row uniqueness make a concurrent replay reserve exactly once.
 */

export interface CreateGenerationInput {
  ownerId: string;
  precheckId: string;
  idempotencyKey: string;
  providerId: string;
  model: string;
}

export type CreateGenerationResult =
  | { ok: true; created: boolean; generationId: string; state: string }
  | { ok: false; code: 'IDEMPOTENCY_CONFLICT' | 'PRECHECK_INVALID' | 'QUOTA_EXCEEDED' };

export interface GenerationDeps {
  pool: { connect(): Promise<Queryable & { release(): void }>; query: Queryable['query'] };
}

function fingerprint(parts: {
  templateVersionId: string;
  inputObjectId: string;
  settings: unknown;
  providerId: string;
  model: string;
}): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export class GenerationService {
  constructor(
    private readonly deps: GenerationDeps,
    private readonly quotaLimit: number,
  ) {}

  async create(input: CreateGenerationInput): Promise<CreateGenerationResult> {
    const precheck = await this.deps.pool.query<{
      subject_id: string;
      template_version_id: string;
      media_object_id: string;
      result: string;
      settings: Record<string, unknown>;
    }>(
      `SELECT p.subject_id, p.template_version_id, p.media_object_id, p.result, p.settings
       FROM precheck p WHERE p.id = $1`,
      [input.precheckId],
    );
    const precheckRow = precheck.rows[0];
    if (
      precheckRow === undefined ||
      precheckRow.subject_id !== input.ownerId ||
      precheckRow.result !== 'passed'
    ) {
      return { ok: false, code: 'PRECHECK_INVALID' };
    }

    const fp = fingerprint({
      templateVersionId: precheckRow.template_version_id,
      inputObjectId: precheckRow.media_object_id,
      settings: precheckRow.settings,
      providerId: input.providerId,
      model: input.model,
    });

    // Fast-path sequential replay (the race is still handled in-transaction).
    const existing = await this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
    if (existing !== null) {
      return existing.fingerprint === fp
        ? { ok: true, created: false, generationId: existing.id, state: existing.state }
        : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    }

    const connection = await this.deps.pool.connect();
    try {
      await connection.query('BEGIN');
      try {
        const inserted = await connection.query<{ id: string }>(
          `INSERT INTO generation (id, owner_id, template_version_id, catalog_release_id,
             precheck_id, input_object_id, input_sha256, compiled_prompt_sha256,
             effective_prompt_sha256, provider_id, model, settings, idempotency_key, state)
           SELECT $1, p.subject_id, p.template_version_id, tv.catalog_release_id, p.id,
                  p.media_object_id, m.sha256, tv.compiled_prompt_sha256, tv.compiled_prompt_sha256,
                  $2, $3, jsonb_build_object('_fingerprint', $4::text, 'request', p.settings),
                  $5, 'queued'
           FROM precheck p
           JOIN template_version tv ON tv.id = p.template_version_id
           JOIN media_object m ON m.id = p.media_object_id
           WHERE p.id = $6 AND p.subject_id = $7 AND p.result = 'passed'
           RETURNING id`,
          [
            randomUUID(),
            input.providerId,
            input.model,
            fp,
            input.idempotencyKey,
            input.precheckId,
            input.ownerId,
          ],
        ).catch((error: unknown) => {
          const code = (error as { code?: string }).code;
          if (code === '23505') {
            // (owner_id, idempotency_key) collision: resolve below.
            return { rows: [], rowCount: null, fields: [], command: '' };
          }
          throw error;
        });

        if (inserted.rows[0] === undefined) {
          // Lost a concurrent race for this idempotency key.
          const existing = await connection.query<{ id: string; state: string; fingerprint: string | null }>(
            `SELECT id, state, settings->>'_fingerprint' AS fingerprint
             FROM generation WHERE owner_id = $1 AND idempotency_key = $2`,
            [input.ownerId, input.idempotencyKey],
          );
          await connection.query('ROLLBACK');
          const row = existing.rows[0];
          if (row === undefined) {
            return { ok: false, code: 'PRECHECK_INVALID' };
          }
          return row.fingerprint === fp
            ? { ok: true, created: false, generationId: row.id, state: row.state }
            : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        }

        const generationId = inserted.rows[0]!.id;

        const quota = new QuotaService(connection, { limit: this.quotaLimit });
        const reserve = await quota.reserveWithinTx(connection, {
          subjectId: input.ownerId,
          generationId,
        });
        if (!reserve.ok && reserve.code === 'QUOTA_EXCEEDED') {
          await connection.query('ROLLBACK');
          return { ok: false, code: 'QUOTA_EXCEEDED' };
        }

        await connection.query(
          `INSERT INTO job (generation_id, kind, state, run_after)
           VALUES ($1, 'generate', 'pending', now())`,
          [generationId],
        );
        await connection.query('COMMIT');

        // Fast-path idempotent replay (existing task, same fingerprint).
        return { ok: true, created: true, generationId, state: 'queued' };
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  /** Sequential (non-concurrent) replay check used before reserving. */
  async findByIdempotencyKey(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; fingerprint: string | null; state: string } | null> {
    const result = await this.deps.pool.query<{
      id: string;
      fingerprint: string | null;
      state: string;
    }>(
      `SELECT id, settings->>'_fingerprint' AS fingerprint, state
       FROM generation WHERE owner_id = $1 AND idempotency_key = $2`,
      [ownerId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }
}

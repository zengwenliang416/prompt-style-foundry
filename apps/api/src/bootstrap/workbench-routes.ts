import type { FastifyInstance } from 'fastify';

import type {
  GenerationCreateRequest,
  GenerationStatusData,
  GenerationStatusMeta,
  PrecheckCreateRequest,
  UploadConfirmRequest,
  UploadCreateRequest,
} from '@onepic/contracts';

import type { Queryable } from '../db/queryable.js';
import type { StoragePort } from '../infra/storage/storage.js';
import type { PgSessionRepository } from '../modules/identity/pg-session-repository.js';
import { GenerationService } from '../modules/generation/create.js';
import { CancelService } from '../modules/generation/cancel.js';
import { DeleteService } from '../modules/generation/delete.js';
import {
  GenerationQueryService,
  type GenerationDetail,
  type GenerationSidecar,
} from '../modules/generation/query.js';
import { PrecheckService, type PrecheckProblem } from '../modules/media/precheck-service.js';
import { UploadService, type UploadProblem } from '../modules/media/upload-service.js';
import { AppError } from './errors.js';
import { parseCookies, sessionCookieName } from './identity-routes.js';
import { openApiSchema } from './schema.js';

/**
 * Workbench routes (W01): upload → precheck → submit → poll → download.
 * Controllers do protocol conversion and object-level authorization only;
 * business rules stay in the service layer (M01/M04/J01/J10). Request and
 * response shapes are validated against the OpenAPI document via
 * openApiSchema — unknown fields fail loudly (app-level removeAdditional:
 * false), and undeclared response fields cannot leak out.
 *
 * Auth: every route requires a valid opaque session cookie; a subject only
 * ever reaches its own uploads/prechecks/generations (cross-user → 403
 * FORBIDDEN, missing → 404 NOT_FOUND, both enforced inside the services).
 */

export interface WorkbenchDeps {
  pool: Queryable & { connect(): Promise<Queryable & { release(): void }> };
  storage: StoragePort;
  sessions: PgSessionRepository;
  /** Allowlisted provider id recorded on managed generations. */
  providerId: string;
  quotaLimit: number;
  signingKey: string;
  downloadTtlSeconds: number;
  /** Client polling hint carried in meta (milliseconds). */
  pollAfterMs?: number;
}

const UPLOAD_BODY_LIMIT = 20 * 1024 * 1024;

const UPLOAD_STATUS: Record<UploadProblem, number> = {
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UPLOAD_EXPIRED: 410,
  INCOMPLETE_UPLOAD: 400,
  HASH_MISMATCH: 400,
  ALREADY_CONFIRMED: 409,
};

const PRECHECK_STATUS: Record<PrecheckProblem, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  TEMPLATE_VERSION_MISMATCH: 409,
  QUARANTINE_NOT_READY: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  PIXEL_LIMIT_EXCEEDED: 413,
  MALFORMED_IMAGE: 400,
  VALIDATION_FAILED: 400,
  PROMPT_REWRITE_BLOCKED: 400,
};

export function registerWorkbenchRoutes(app: FastifyInstance, deps: WorkbenchDeps): void {
  const uploads = new UploadService(deps.pool, deps.storage);
  const prechecks = new PrecheckService(deps.pool, deps.storage);
  const generations = new GenerationService({ pool: deps.pool }, deps.quotaLimit);
  const cancels = new CancelService(deps.pool);
  const deletes = new DeleteService(deps.pool, deps.storage);
  const queries = new GenerationQueryService(deps.pool, {
    signingKey: deps.signingKey,
    downloadTtlSeconds: deps.downloadTtlSeconds,
  });
  const pollAfterMs = deps.pollAfterMs ?? 2000;

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  async function requireSubject(headers: { cookie?: string }): Promise<string> {
    const token = parseCookies(headers.cookie)[sessionCookieName()] ?? '';
    const session = token === '' ? null : await deps.sessions.resolve(token);
    if (session === null) {
      throw new AppError(401, 'UNAUTHENTICATED', 'No active session');
    }
    return session.subjectId;
  }

  app.post(
    '/api/v1/uploads',
    {
      schema: {
        body: openApiSchema('UploadCreateRequest'),
        response: { 201: openApiSchema('ApiSuccessOfUploadSession') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const body = request.body as UploadCreateRequest;
      const created = await uploads.createUpload({
        ownerId: subjectId,
        declaredBytes: body.declaredBytes,
        declaredMime: body.declaredMime,
      });
      if (!created.ok) {
        throw new AppError(UPLOAD_STATUS[created.problem], created.problem, created.message);
      }
      return await reply.code(201).send({
        data: {
          uploadId: created.value.uploadId,
          bucket: created.value.bucket,
          expiresAt: created.value.expiresAt.toISOString(),
        },
      });
    },
  );

  app.put(
    '/api/v1/uploads/:uploadId/bytes',
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { uploadId } = request.params as { uploadId: string };
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new AppError(400, 'VALIDATION_FAILED', 'expected application/octet-stream body');
      }
      const placed = await uploads.putQuarantineBytes(uploadId, subjectId, body);
      if (!placed.ok) {
        throw new AppError(UPLOAD_STATUS[placed.problem], placed.problem, placed.message);
      }
      return await reply.send({ data: { bytes: placed.value.bytes } });
    },
  );

  app.post(
    '/api/v1/uploads/:uploadId/confirm',
    {
      schema: {
        body: openApiSchema('UploadConfirmRequest'),
        response: { 200: openApiSchema('ApiSuccessOfUploadConfirmed') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { uploadId } = request.params as { uploadId: string };
      const body = request.body as UploadConfirmRequest;
      const confirmed = await uploads.confirmUpload({
        uploadId,
        ownerId: subjectId,
        actualSha256: body.sha256,
      });
      if (!confirmed.ok) {
        throw new AppError(UPLOAD_STATUS[confirmed.problem], confirmed.problem, confirmed.message);
      }
      return await reply.send({
        data: { mediaObjectId: confirmed.value.mediaObjectId, bytes: confirmed.value.bytes },
      });
    },
  );

  app.post(
    '/api/v1/prechecks',
    {
      schema: {
        body: openApiSchema('PrecheckCreateRequest'),
        response: { 201: openApiSchema('ApiSuccessOfPrecheckCreated') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const body = request.body as PrecheckCreateRequest;
      const outcome = await prechecks.createPrecheck({
        subjectId,
        templateKey: body.templateId,
        version: body.templateVersion,
        mediaObjectId: body.sourceObjectId,
        settings: {
          ...(body.settings.model !== undefined ? { model: body.settings.model } : {}),
          ...(body.settings.quality !== undefined ? { quality: body.settings.quality } : {}),
          aspect: 'inherit',
        },
      });
      if (!outcome.ok) {
        throw new AppError(PRECHECK_STATUS[outcome.problem], outcome.problem, outcome.message);
      }
      return await reply.code(201).send({
        data: {
          precheckId: outcome.value.precheckId,
          expiresAt: outcome.value.expiresAt.toISOString(),
        },
      });
    },
  );

  app.post(
    '/api/v1/generations',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
        body: openApiSchema('GenerationCreateRequest'),
        response: { 202: openApiSchema('ApiSuccessOfGenerationStatus') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const body = request.body as GenerationCreateRequest;
      const idempotencyKey = request.headers['idempotency-key'] as string;

      // The server re-reads the immutable template version and compares the
      // hash — a browser body can never substitute prompt text (§6/J05).
      const version = await deps.pool.query<{ id: string; compiled_prompt_sha256: string }>(
        'SELECT id, compiled_prompt_sha256 FROM template_version WHERE template_key = $1 AND version = $2',
        [body.templateId, body.templateVersion],
      );
      const versionRow = version.rows[0];
      if (versionRow === undefined) {
        throw new AppError(
          409,
          'TEMPLATE_VERSION_MISMATCH',
          `template ${body.templateId}@${body.templateVersion} is not in the imported catalog`,
        );
      }
      if (versionRow.compiled_prompt_sha256 !== body.promptSha256) {
        throw new AppError(
          400,
          'PROMPT_REWRITE_BLOCKED',
          'promptSha256 does not match the immutable template version',
        );
      }
      if (body.precheckId === undefined) {
        throw new AppError(400, 'PRECHECK_FAILED', 'precheckId is required');
      }
      const gate = await prechecks.validateForGeneration({
        precheckId: body.precheckId,
        subjectId,
        templateVersionId: versionRow.id,
        inputObjectId: body.sourceObjectId,
      });
      if (!gate.ok) {
        throw new AppError(PRECHECK_STATUS[gate.problem], gate.problem, gate.message);
      }

      const created = await generations.create({
        ownerId: subjectId,
        precheckId: body.precheckId,
        idempotencyKey,
        providerId: deps.providerId,
        model: body.settings.model,
      });
      if (!created.ok) {
        if (created.code === 'IDEMPOTENCY_CONFLICT') {
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotency key reused with a different request',
          );
        }
        if (created.code === 'QUOTA_EXCEEDED') {
          throw new AppError(429, 'QUOTA_EXCEEDED', 'generation quota exceeded');
        }
        throw new AppError(400, 'PRECHECK_FAILED', 'precheck is not usable for generation');
      }

      const detail = await queries.getGeneration({ generationId: created.generationId, subjectId });
      if (!detail.ok) {
        throw new AppError(500, 'INTERNAL', 'created generation is not readable');
      }
      return await reply.code(202).send(statusEnvelope(detail.value, pollAfterMs));
    },
  );

  app.get(
    '/api/v1/generations/:generationId',
    {
      schema: {
        response: { 200: openApiSchema('ApiSuccessOfGenerationStatus') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { generationId } = request.params as { generationId: string };
      const detail = await queries.getGeneration({ generationId, subjectId });
      if (!detail.ok) {
        throw new AppError(
          detail.code === 'FORBIDDEN' ? 403 : 404,
          detail.code,
          detail.code === 'FORBIDDEN' ? 'generation not accessible' : 'generation not found',
        );
      }
      return await reply.send(statusEnvelope(detail.value, pollAfterMs));
    },
  );

  app.get(
    '/api/v1/generations/:generationId/sidecar',
    {
      schema: {
        response: { 200: openApiSchema('ApiSuccessOfGenerationSidecar') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { generationId } = request.params as { generationId: string };
      const sidecar = await queries.getSidecar({ generationId, subjectId });
      if (!sidecar.ok) {
        throw new AppError(
          sidecar.code === 'FORBIDDEN' ? 403 : 404,
          sidecar.code,
          sidecar.code === 'FORBIDDEN' ? 'generation not accessible' : 'generation not found',
        );
      }
      return await reply.send({ data: sidecar.value satisfies GenerationSidecar });
    },
  );

  // J08 over HTTP (W02): the service layer owns the honesty rules — queued
  // cancels immediately, running only records a request, terminal states are
  // reported as-is, and outcome_unknown refuses (409).
  app.post(
    '/api/v1/generations/:generationId/cancel',
    {
      schema: {
        response: { 200: openApiSchema('ApiSuccessOfGenerationCancel') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { generationId } = request.params as { generationId: string };
      const result = await cancels.cancel({ generationId, subjectId });
      if (!result.ok) {
        if (result.code === 'FORBIDDEN') {
          throw new AppError(403, 'FORBIDDEN', 'generation not accessible');
        }
        if (result.code === 'NOT_FOUND') {
          throw new AppError(404, 'NOT_FOUND', 'generation not found');
        }
        throw new AppError(
          409,
          'GENERATION_STATE_ILLEGAL',
          'outcome_unknown tasks exit via reconciliation, not user cancel',
        );
      }
      return await reply.send({
        data: {
          id: generationId,
          state: result.state,
          outcome: result.outcome,
          ...(result.code !== undefined ? { code: result.code } : {}),
        },
      });
    },
  );

  // O01: user deletion. History rows (generation/attempt/result metadata and
  // hashes) are never rewritten — the result media bytes are physically
  // removed and recorded in the deletion manifest, and any previously signed
  // download URL immediately returns 410. outcome_unknown refuses (409).
  app.delete(
    '/api/v1/generations/:generationId',
    {
      schema: {
        response: { 200: openApiSchema('ApiSuccessOfGenerationDelete') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { generationId } = request.params as { generationId: string };
      const result = await deletes.delete({ generationId, subjectId });
      if (!result.ok) {
        if (result.code === 'FORBIDDEN') {
          throw new AppError(403, 'FORBIDDEN', 'generation not accessible');
        }
        if (result.code === 'NOT_FOUND') {
          throw new AppError(404, 'NOT_FOUND', 'generation not found');
        }
        throw new AppError(
          409,
          'GENERATION_STATE_ILLEGAL',
          'outcome_unknown tasks exit via reconciliation, not user deletion',
        );
      }
      return await reply.send({
        data: {
          id: generationId,
          deleted: true,
          state: result.state,
          ...(result.code !== undefined ? { code: result.code } : {}),
        },
      });
    },
  );
}

function statusEnvelope(
  detail: GenerationDetail,
  pollAfterMs: number,
): { data: GenerationStatusData; meta: GenerationStatusMeta } {
  const data: GenerationStatusData = {
    id: detail.generationId,
    state: detail.state as GenerationStatusData['state'],
    templateId: detail.templateKey,
    templateVersion: detail.templateVersion,
    createdAt: detail.createdAt,
    ...(detail.errorCode !== null ? { errorCode: detail.errorCode } : {}),
    ...(detail.completedAt !== null ? { completedAt: detail.completedAt } : {}),
    ...(detail.result !== null
      ? {
          result: {
            objectId: detail.result.objectId,
            actualMime: detail.result.actualMime as 'image/jpeg' | 'image/png' | 'image/webp',
            actualBytes: detail.result.actualBytes,
            actualWidth: detail.result.actualWidth,
            actualHeight: detail.result.actualHeight,
            sha256: detail.result.sha256,
          },
        }
      : {}),
  };
  const meta: GenerationStatusMeta = {
    pollAfterMs,
    ...(detail.downloadUrl !== null ? { downloadUrl: detail.downloadUrl } : {}),
    ...(detail.downloadExpires !== null ? { downloadExpires: detail.downloadExpires } : {}),
  };
  return { data, meta };
}

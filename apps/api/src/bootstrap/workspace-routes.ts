import type { FastifyInstance } from 'fastify';

import {
  GENERATION_STATUSES,
  type CollectionItemAddRequest,
  type CollectionCreateRequest,
} from '@onepic/contracts';

import type { Queryable } from '../db/queryable.js';
import type { PgSessionRepository } from '../modules/identity/pg-session-repository.js';
import { CollectionService, type CollectionProblem } from '../modules/workspace/collections.js';
import { HistoryService } from '../modules/workspace/history.js';
import { WorkspaceExportService } from '../modules/workspace/export.js';
import { AppError } from './errors.js';
import { parseCookies, sessionCookieName } from './identity-routes.js';
import { openApiSchema } from './schema.js';

/**
 * Workspace routes (W03): history cursor pagination + collections/favorites.
 * Controllers do protocol conversion and authorization mapping only; the
 * service layer owns the acceptance rules (cross-user isolation, stable
 * keyset ordering, idempotent favoriting, collection deletion that never
 * touches generations or media). Unknown request/query fields fail loudly
 * (additionalProperties: false + app-level removeAdditional: false), and
 * response schemas strip anything the contract does not declare.
 */

export interface WorkspaceDeps {
  pool: Queryable;
  sessions: PgSessionRepository;
  /** Signs pagination cursors (same key family as signed media URLs). */
  signingKey: string;
}

const COLLECTION_STATUS: Record<CollectionProblem, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  NAME_CONFLICT: 409,
  INVALID_NAME: 400,
  INVALID_ITEM_KEY: 400,
  INVALID_CURSOR: 400,
};

const COLLECTION_CODE: Record<CollectionProblem, string> = {
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  NAME_CONFLICT: 'COLLECTION_NAME_CONFLICT',
  INVALID_NAME: 'VALIDATION_FAILED',
  INVALID_ITEM_KEY: 'VALIDATION_FAILED',
  INVALID_CURSOR: 'VALIDATION_FAILED',
};

// Mirrors the query parameters declared in openapi/api-v1.yaml; unknown
// query fields are rejected (400) instead of silently ignored.
const PAGE_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
} as const;

const HISTORY_QUERY = {
  ...PAGE_QUERY,
  properties: {
    ...PAGE_QUERY.properties,
    state: { type: 'string', enum: [...GENERATION_STATUSES] },
  },
} as const;

const COLLECTION_ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['collectionId'],
  properties: { collectionId: { type: 'string', format: 'uuid' } },
} as const;

const ITEM_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['collectionId', 'itemType', 'itemKey'],
  properties: {
    collectionId: { type: 'string', format: 'uuid' },
    itemType: { type: 'string', enum: ['template', 'generation'] },
    itemKey: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

interface PageQuery {
  cursor?: string;
  limit?: number;
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceDeps): void {
  const history = new HistoryService(deps.pool, { signingKey: deps.signingKey });
  const collections = new CollectionService(deps.pool, { signingKey: deps.signingKey });
  const exportsService = new WorkspaceExportService(deps.pool, { signingKey: deps.signingKey });

  async function requireSubject(headers: { cookie?: string }): Promise<string> {
    const token = parseCookies(headers.cookie)[sessionCookieName()] ?? '';
    const session = token === '' ? null : await deps.sessions.resolve(token);
    if (session === null) {
      throw new AppError(401, 'UNAUTHENTICATED', 'No active session');
    }
    return session.subjectId;
  }

  function throwProblem(problem: CollectionProblem): never {
    throw new AppError(
      COLLECTION_STATUS[problem],
      COLLECTION_CODE[problem],
      problemMessage(problem),
    );
  }

  app.get(
    '/api/v1/generations',
    {
      schema: {
        querystring: HISTORY_QUERY,
        response: { 200: openApiSchema('ApiSuccessOfGenerationList') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const query = request.query as PageQuery & { state?: string };
      const page = await history.listGenerations({
        subjectId,
        ...(query.state !== undefined ? { state: query.state } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      if (!page.ok) {
        throwProblem(page.code);
      }
      return await reply.send({
        data: {
          items: page.value.items.map((item) => ({
            id: item.generationId,
            state: item.state,
            templateId: item.templateKey,
            templateVersion: item.templateVersion,
            createdAt: item.createdAt,
            ...(item.errorCode !== null ? { errorCode: item.errorCode } : {}),
            ...(item.completedAt !== null ? { completedAt: item.completedAt } : {}),
          })),
        },
        meta: page.value.nextCursor !== null ? { nextCursor: page.value.nextCursor } : {},
      });
    },
  );

  app.get(
    '/api/v1/exports/workspace',
    {
      schema: {
        response: { 200: openApiSchema('ApiSuccessOfWorkspaceExport') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const document = await exportsService.export({ subjectId });
      return await reply.send({ data: document });
    },
  );

  app.get(
    '/api/v1/collections',
    {
      schema: {
        querystring: PAGE_QUERY,
        response: { 200: openApiSchema('ApiSuccessOfCollectionList') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const query = request.query as PageQuery;
      const page = await collections.list({
        subjectId,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      if (!page.ok) {
        throwProblem(page.code);
      }
      return await reply.send({
        data: { items: page.value.items },
        meta: page.value.nextCursor !== null ? { nextCursor: page.value.nextCursor } : {},
      });
    },
  );

  app.post(
    '/api/v1/collections',
    {
      schema: {
        body: openApiSchema('CollectionCreateRequest'),
        response: { 201: openApiSchema('ApiSuccessOfCollectionSummary') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const body = request.body as CollectionCreateRequest;
      const created = await collections.create({ subjectId, name: body.name });
      if (!created.ok) {
        throwProblem(created.code);
      }
      return await reply.code(201).send({ data: created.value });
    },
  );

  app.delete(
    '/api/v1/collections/:collectionId',
    {
      schema: {
        params: COLLECTION_ID_PARAMS,
        response: { 200: openApiSchema('ApiSuccessOfCollectionDeleted') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { collectionId } = request.params as { collectionId: string };
      const removed = await collections.remove({ subjectId, collectionId });
      if (!removed.ok) {
        throwProblem(removed.code);
      }
      return await reply.send({ data: { id: removed.value.id, deleted: true } });
    },
  );

  app.post(
    '/api/v1/collections/:collectionId/items',
    {
      schema: {
        params: COLLECTION_ID_PARAMS,
        body: openApiSchema('CollectionItemAddRequest'),
        response: { 200: openApiSchema('ApiSuccessOfCollectionItem') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const { collectionId } = request.params as { collectionId: string };
      const body = request.body as CollectionItemAddRequest;
      const added = await collections.addItem({
        subjectId,
        collectionId,
        itemType: body.itemType,
        itemKey: body.itemKey,
      });
      if (!added.ok) {
        throwProblem(added.code);
      }
      return await reply.send({ data: added.value });
    },
  );

  app.delete(
    '/api/v1/collections/:collectionId/items/:itemType/:itemKey',
    {
      schema: {
        params: ITEM_PARAMS,
        response: { 200: openApiSchema('ApiSuccessOfCollectionItemRemoval') },
      },
    },
    async (request, reply) => {
      const subjectId = await requireSubject(request.headers);
      const params = request.params as {
        collectionId: string;
        itemType: 'template' | 'generation';
        itemKey: string;
      };
      const removed = await collections.removeItem({
        subjectId,
        collectionId: params.collectionId,
        itemType: params.itemType,
        itemKey: params.itemKey,
      });
      if (!removed.ok) {
        throwProblem(removed.code);
      }
      return await reply.send({
        data: {
          collectionId: params.collectionId,
          itemType: params.itemType,
          itemKey: params.itemKey,
          removed: removed.value.removed,
        },
      });
    },
  );
}

function problemMessage(problem: CollectionProblem): string {
  switch (problem) {
    case 'NOT_FOUND':
      return 'resource not found';
    case 'FORBIDDEN':
      return 'resource not accessible';
    case 'NAME_CONFLICT':
      return 'a collection with this name already exists';
    case 'INVALID_NAME':
      return 'collection name must be 1-80 non-blank characters';
    case 'INVALID_ITEM_KEY':
      return 'itemKey does not match the declared itemType';
    case 'INVALID_CURSOR':
      return 'cursor is malformed or failed signature verification';
  }
}

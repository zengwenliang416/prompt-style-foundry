import { Pool } from 'pg';
import Fastify from 'fastify';

import type { ApiConfig } from '../config/env.js';
import { LocalDiskStorage } from '../infra/storage/storage.js';
import { OidcAdapter } from '../modules/identity/oidc-adapter.js';
import { verifySignedMedia } from '../modules/media/signed-access.js';
import { PgSessionRepository } from '../modules/identity/pg-session-repository.js';
import { registerIdentityRoutes } from './identity-routes.js';
import { registerWorkbenchRoutes } from './workbench-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';

import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes } from './health.js';
import { buildLoggerOptions } from './logging.js';

/**
 * Composes the modular-monolith API (architecture §2). Domain modules
 * (catalog/generation/media/identity/workspace/policy) plug in here as
 * their checklist items (B/M/J phases) land; controllers stay limited to
 * protocol conversion and authorization.
 */
export interface BuildAppOptions {
  /** Test hook: capture the pino stream (sentinel leak assertions, O02). */
  logStream?: import('pino').DestinationStream;
}

export function buildApp(config: ApiConfig, options?: BuildAppOptions) {
  const app = Fastify({
    logger: buildLoggerOptions(config.logLevel, options?.logStream),
    trustProxy: true,
    // Fail loud on request fields the contract does not declare instead of
    // silently stripping them (fastify's default removeAdditional would drop
    // them and pass validation).
    ajv: {
      customOptions: { removeAdditional: false },
    },
  });

  registerErrorHandling(app, config);
  registerHealthRoutes(app, config);

  // Managed identity and all server-side generation surfaces are controlled by
  // RUN_MODE, not by the accidental presence of retained DB/OIDC variables.
  // catalog-only and direct-byok stay stateless even if operators keep those
  // variables ready for a later mode switch (ADR 0003).
  const {
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    oidcRedirectUri,
    sessionSecret,
    databaseUrl,
  } = config;
  const identityConfigured =
    oidcIssuer !== undefined &&
    oidcClientId !== undefined &&
    oidcClientSecret !== undefined &&
    oidcRedirectUri !== undefined &&
    sessionSecret !== undefined &&
    databaseUrl !== undefined;
  if (config.runMode === 'managed-generation' && identityConfigured) {
    const pool = new Pool({ connectionString: databaseUrl });
    const redirectUri = new URL(oidcRedirectUri);
    const signingKey = sessionSecret;
    const sessions = new PgSessionRepository(pool);
    const storage = new LocalDiskStorage(config.mediaStorageRoot ?? '/var/lib/onepic/media');

    // Private media access (M03): signed, owner-bound, short-lived, private
    // cache policy. No public object serving exists. The signature's owner
    // must ALSO match the requesting session — leaking a link to another
    // user never grants access.
    app.get('/api/v1/media/:bucket/*', async (request, reply) => {
      const raw = request.params as { bucket: string; '*': string };
      const params = { bucket: raw.bucket, key: raw['*'].replace(/^\//, '') };
      const query = request.query as Record<string, string | undefined>;
      const signedOwner = query['owner'] ?? '';
      const verdict = verifySignedMedia(
        {
          bucket: params.bucket,
          key: params.key,
          ownerId: signedOwner,
          expires: query['expires'],
          signature: query['signature'],
          method: 'GET',
        },
        signingKey,
      );
      if (!verdict.ok) {
        const status = verdict.code === 'MEDIA_EXPIRED' ? 410 : verdict.foreign ? 404 : 403;
        return await reply.code(status).send({
          error: { code: verdict.code, message: 'media access denied', correlationId: request.id },
        });
      }
      const cookies = (request.headers.cookie ?? '')
        .split(';')
        .map((pair) => pair.trim())
        .find((pair) => pair.startsWith('onepic_session='));
      const token = cookies === undefined ? '' : cookies.slice('onepic_session='.length);
      const session = token === '' ? null : await sessions.resolve(token);
      if (session === null || session.subjectId !== signedOwner) {
        return await reply.code(404).send({
          error: { code: 'FORBIDDEN', message: 'media access denied', correlationId: request.id },
        });
      }
      // O01: a valid signature is necessary but not sufficient — the object
      // state is re-checked against the database so retention expiry and user
      // deletion revoke already-issued signed URLs immediately. Only a live
      // ('ready', unexpired) object may be downloaded.
      const media = await pool.query<{ state: string; expires_at: Date; mime: string | null }>(
        'SELECT state, expires_at, mime FROM media_object WHERE bucket = $1 AND object_key = $2',
        [params.bucket, params.key],
      );
      const mediaRow = media.rows[0];
      if (mediaRow === undefined) {
        return await reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'media not found', correlationId: request.id },
        });
      }
      if (mediaRow.state !== 'ready' || mediaRow.expires_at.getTime() <= Date.now()) {
        return await reply.code(410).send({
          error: {
            code: 'MEDIA_EXPIRED',
            message: 'media is no longer available',
            correlationId: request.id,
          },
        });
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaRow.mime ?? '')) {
        return await reply.code(500).send({
          error: {
            code: 'MEDIA_METADATA_INVALID',
            message: 'media MIME metadata is invalid',
            correlationId: request.id,
          },
        });
      }
      const body = await storage.get({ bucket: params.bucket, key: params.key });
      reply.header('cache-control', 'private, no-store');
      reply.type(mediaRow.mime!);
      return await reply.send(body);
    });

    registerIdentityRoutes(app, {
      provider: new OidcAdapter({
        issuer: oidcIssuer,
        clientId: oidcClientId,
        clientSecret: oidcClientSecret,
        redirectUri: oidcRedirectUri,
      }),
      sessions,
      allowedOrigin: redirectUri.origin,
      secureCookies: redirectUri.protocol === 'https:',
      sessionTtlSeconds: 60 * 60 * 24 * 7,
    });

    // Workbench (W01): upload → precheck → submit → poll → signed download.
    // Registered only with identity+PG because every route is session-bound;
    // catalog-only / direct-byok deployments never expose them.
    registerWorkbenchRoutes(app, {
      pool,
      storage,
      sessions,
      signingKey,
      providerId: config.managedProviderId ?? 'managed-primary',
      quotaLimit: config.generationQuotaLimit ?? 20,
      downloadTtlSeconds: 300,
    });

    // Workspace (W03): history cursor pagination + collections/favorites.
    // Same session-bound registration boundary as the workbench routes.
    registerWorkspaceRoutes(app, { pool, sessions, signingKey });

    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  return app;
}

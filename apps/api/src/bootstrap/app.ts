import { Pool } from 'pg';
import Fastify from 'fastify';

import type { ApiConfig } from '../config/env.js';
import { LocalDiskStorage } from '../infra/storage/storage.js';
import { OidcAdapter } from '../modules/identity/oidc-adapter.js';
import { verifySignedMedia } from '../modules/media/signed-access.js';
import { PgSessionRepository } from '../modules/identity/pg-session-repository.js';
import { registerIdentityRoutes } from './identity-routes.js';

import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes } from './health.js';

/**
 * Composes the modular-monolith API (architecture §2). Domain modules
 * (catalog/generation/media/identity/workspace/policy) plug in here as
 * their checklist items (B/M/J phases) land; controllers stay limited to
 * protocol conversion and authorization.
 */
export function buildApp(config: ApiConfig) {
  const app = Fastify({
    logger: { level: config.logLevel },
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

  // Identity (B03): active when the deployment provides both an OIDC source
  // and PG. managed-generation additionally requires these (ADR 0001 D-4);
  // catalog-only deployments without them simply have no auth routes.
  const { oidcIssuer, oidcClientId, oidcClientSecret, oidcRedirectUri, databaseUrl } = config;
  const identityConfigured =
    oidcIssuer !== undefined &&
    oidcClientId !== undefined &&
    oidcClientSecret !== undefined &&
    oidcRedirectUri !== undefined &&
    databaseUrl !== undefined;
  if (identityConfigured) {
    const pool = new Pool({ connectionString: databaseUrl });
    const redirectUri = new URL(oidcRedirectUri);
    const signingKey = oidcClientSecret;
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
      const body = await storage.get({ bucket: params.bucket, key: params.key });
      reply.header('cache-control', 'private, no-store');
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
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  return app;
}

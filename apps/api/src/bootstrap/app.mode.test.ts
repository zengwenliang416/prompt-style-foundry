import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../config/env.js';
import { buildApp } from './app.js';
import { signMediaPath } from '../modules/media/signed-access.js';

const retainedManagedSettings: ApiConfig = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'fatal',
  runMode: 'catalog-only',
  databaseUrl: 'postgresql://onepic:local-only@127.0.0.1:1/unused',
  oidcIssuer: 'https://identity.example.test',
  oidcClientId: 'onepic-test',
  oidcClientSecret: 'not-a-real-client-secret',
  oidcRedirectUri: 'https://onepic.example.test/api/v1/auth/callback',
  sessionSecret: 'not-a-real-session-secret-at-least-32-characters',
  managedProviderId: 'managed-primary',
  mediaStorageRoot: '/tmp/onepic-unused-media',
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('RUN_MODE route boundary', () => {
  for (const runMode of ['catalog-only', 'direct-byok'] as const) {
    it(`${runMode} does not expose managed routes even when DB/OIDC settings are retained`, async () => {
      app = buildApp({ ...retainedManagedSettings, runMode });
      await app.ready();

      const managedRequests = [
        { method: 'GET', url: '/api/v1/auth/me' },
        { method: 'POST', url: '/api/v1/uploads' },
        { method: 'POST', url: '/api/v1/prechecks' },
        { method: 'GET', url: '/api/v1/generations/00000000-0000-4000-8000-000000000000' },
        { method: 'GET', url: '/api/v1/collections' },
        { method: 'GET', url: '/api/v1/exports/workspace' },
        {
          method: 'GET',
          url: '/api/v1/media/result/some-object?owner=x&expires=1&signature=x',
        },
      ] as const;

      for (const request of managedRequests) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
      }

      const health = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
      expect(health.statusCode).toBe(200);
    });
  }

  it('uses SESSION_SECRET rather than OIDC_CLIENT_SECRET for application signatures', async () => {
    const managed = { ...retainedManagedSettings, runMode: 'managed-generation' as const };
    app = buildApp(managed);
    await app.ready();
    const input = {
      bucket: 'private',
      key: 'owner/result.png',
      ownerId: '00000000-0000-4000-8000-000000000001',
      method: 'GET' as const,
      ttlSeconds: 300,
    };

    const applicationSigned = signMediaPath(input, managed.sessionSecret!);
    const validSignatureWithoutSession = await app.inject({
      method: 'GET',
      url: applicationSigned.path,
    });
    expect(validSignatureWithoutSession.statusCode).toBe(404);

    const oidcSigned = signMediaPath(input, managed.oidcClientSecret!);
    const wrongKey = await app.inject({ method: 'GET', url: oidcSigned.path });
    expect(wrongKey.statusCode).toBe(403);
  });
});

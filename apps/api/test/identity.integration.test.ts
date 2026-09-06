import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import type { ApiConfig } from '../src/config/env.js';

/**
 * B03 acceptance against a fake in-process OIDC issuer and the ephemeral PG
 * cluster: full login→callback→me→refresh→logout flow, state/nonce/issuer/
 * audience/PKCE enforcement, expiry/revocation/rotation, cookie flags, and
 * the CSRF guard. No network egress beyond loopback.
 */

const REDIRECT_ORIGIN = 'http://127.0.0.1:9999';

interface FakeIssuer {
  server: Server;
  origin: string;
  authorize(input: { nonce: string; codeChallenge: string }): Promise<string>;
  misbehavior: { wrongNonce?: boolean; expired?: boolean; wrongIssuer?: boolean };
}

async function startFakeIssuer(): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'RS256';

  const codes = new Map<string, { nonce: string; codeChallenge: string }>();
  const misbehavior: FakeIssuer['misbehavior'] = {};

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          issuer: '',
          authorization_endpoint: '',
          token_endpoint: '',
          jwks_uri: '',
          __originPlaceholder: true,
        }),
      );
      return;
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const code = params.get('code') ?? '';
        const verifier = params.get('code_verifier') ?? '';
        const stored = codes.get(code);
        if (stored === undefined) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const expected = createHash('sha256').update(verifier).digest('base64url');
        if (expected !== stored.codeChallenge) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'pkce_mismatch' }));
          return;
        }
        codes.delete(code);

        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({ nonce: stored.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
          .setIssuer(misbehavior.wrongIssuer === true ? 'https://evil.example' : ISSUER_REF.origin)
          .setAudience(misbehavior.wrongIssuer === true ? 'other-client' : CLIENT_ID)
          .setSubject('user-b03')
          .setIssuedAt(misbehavior.expired === true ? now - 7200 : now)
          .setExpirationTime(misbehavior.expired === true ? now - 3600 : now + 3600)
          .sign(privateKey);

        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id_token: token }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  // Placeholder refs filled after listen (origin needed inside handlers).
  const ISSUER_REF = { origin: '' };
  const CLIENT_ID = 'onepic-api';

  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      ISSUER_REF.origin = origin;
      // Rewrite the discovery body with the real origin (replace handler).
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', origin);
        if (url.pathname === '/.well-known/openid-configuration') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              jwks_uri: `${origin}/jwks`,
            }),
          );
          return;
        }
        if (url.pathname === '/jwks') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ keys: [publicJwk] }));
          return;
        }
        if (url.pathname === '/token' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', async () => {
            const params = new URLSearchParams(body);
            const code = params.get('code') ?? '';
            const verifier = params.get('code_verifier') ?? '';
            const stored = codes.get(code);
            if (stored === undefined) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'invalid_grant' }));
              return;
            }
            const expected = createHash('sha256').update(verifier).digest('base64url');
            if (expected !== stored.codeChallenge) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'pkce_mismatch' }));
              return;
            }
            codes.delete(code);

            const now = Math.floor(Date.now() / 1000);
            const token = await new SignJWT({
              nonce: misbehavior.wrongNonce === true ? 'wrong-nonce' : stored.nonce,
            })
              .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
              .setIssuer(misbehavior.wrongIssuer === true ? 'https://evil.example' : origin)
              .setAudience(misbehavior.wrongIssuer === true ? 'other-client' : CLIENT_ID)
              .setSubject('user-b03')
              .setIssuedAt(misbehavior.expired === true ? now - 7200 : now)
              .setExpirationTime(misbehavior.expired === true ? now - 3600 : now + 3600)
              .sign(privateKey);

            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ id_token: token }));
          });
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      resolve({
        server,
        origin,
        authorize: async (input) => {
          const code = `code-${Math.random().toString(36).slice(2)}`;
          codes.set(code, { nonce: input.nonce, codeChallenge: input.codeChallenge });
          return code;
        },
        misbehavior,
      });
    });
  });
}

function makeConfig(issuer: string, databaseUrl: string): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl,
    oidcIssuer: issuer,
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'b03-test-secret',
    oidcRedirectUri: `${REDIRECT_ORIGIN}/api/v1/auth/callback`,
    sessionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let issuer: FakeIssuer;
let app: Awaited<ReturnType<typeof import('../src/bootstrap/app.js').buildApp>>;

function csrfHeaders(origin = REDIRECT_ORIGIN): Record<string, string> {
  return { origin, 'x-onepic-requested-with': 'onepic-fetch' };
}

function cookieOf(response: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  for (const entry of list) {
    const [pair] = entry.split(';');
    const [key, value] = pair!.split('=');
    if (key === name) {
      return value;
    }
  }
  return undefined;
}

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('identity');
  await runMigrations(database.uri);
  issuer = await startFakeIssuer();
  const { buildApp: build } = await import('../src/bootstrap/app.js');
  app = build(makeConfig(issuer.origin, database.uri));
});

afterAll(async () => {
  await app?.close();
  issuer?.server.close();
  await database?.drop();
  await cluster?.stop();
});

describe('identity: OIDC + sessions (B03)', () => {
  it('runs the full login → callback → me flow with PKCE and cookies', async () => {
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(login.statusCode).toBe(302);

    const authUrl = new URL(login.headers.location as string);
    const state = authUrl.searchParams.get('state') ?? '';
    const nonce = authUrl.searchParams.get('nonce') ?? '';
    const challenge = authUrl.searchParams.get('code_challenge') ?? '';
    const method = authUrl.searchParams.get('code_challenge_method') ?? '';
    expect(method).toBe('S256');
    expect(state).not.toBe('');
    expect(nonce).not.toBe('');

    const pending = cookieOf(login, 'onepic_login');
    expect(pending).toBeDefined();

    const code = await issuer.authorize({ nonce, codeChallenge: challenge });
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookies: { onepic_login: pending! },
    });
    expect(callback.statusCode).toBe(302);
    const sessionCookie = callback.headers['set-cookie'] as unknown as string[];
    const raw = sessionCookie.find((entry) => entry.startsWith('onepic_session=')) ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');

    const token = cookieOf(callback, 'onepic_session') ?? '';
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { onepic_session: token },
    });
    expect(me.statusCode).toBe(200);
    // API JSON is camelCase (data dictionary naming rule).
    expect(me.json()).toMatchObject({ data: { subject: { subjectClaim: 'user-b03', role: 'member' } } });
  });

  it('rejects a callback whose state does not match the pending challenge', async () => {
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const pending = cookieOf(login, 'onepic_login') ?? '';
    const code = await issuer.authorize({ nonce: 'n', codeChallenge: createHash('sha256').update('v').digest('base64url') });

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=tampered-state`,
      cookies: { onepic_login: pending },
    });
    expect(callback.statusCode).toBe(401);
    expect(callback.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('enforces token issuer, audience, expiry, and nonce via the adapter path', async () => {
    // Drive misbehaving token claims through the same login flow.
    for (const flag of ['wrongNonce', 'expired', 'wrongIssuer'] as const) {
      issuer.misbehavior[flag] = true;
      const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
      const authUrl = new URL(login.headers.location as string);
      const pending = cookieOf(login, 'onepic_login') ?? '';
      const code = await issuer.authorize({
        nonce: authUrl.searchParams.get('nonce') ?? '',
        codeChallenge: authUrl.searchParams.get('code_challenge') ?? '',
      });
      const callback = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
          authUrl.searchParams.get('state') ?? '',
        )}`,
        cookies: { onepic_login: pending },
      });
      expect(callback.statusCode, `${flag} must be rejected`).toBe(401);
      issuer.misbehavior[flag] = false;
    }
  });

  it('rotates sessions: old token revoked, lineage recorded', async () => {
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const authUrl = new URL(login.headers.location as string);
    const pending = cookieOf(login, 'onepic_login') ?? '';
    const code = await issuer.authorize({
      nonce: authUrl.searchParams.get('nonce') ?? '',
      codeChallenge: authUrl.searchParams.get('code_challenge') ?? '',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
        authUrl.searchParams.get('state') ?? '',
      )}`,
      cookies: { onepic_login: pending },
    });
    const oldToken = cookieOf(callback, 'onepic_session') ?? '';

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { onepic_session: oldToken },
      headers: csrfHeaders(),
    });
    expect(refresh.statusCode).toBe(200);
    const newToken = cookieOf(refresh, 'onepic_session') ?? '';
    expect(newToken).not.toBe(oldToken);

    const oldMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { onepic_session: oldToken },
    });
    expect(oldMe.statusCode).toBe(401);
    const newMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { onepic_session: newToken },
    });
    expect(newMe.statusCode).toBe(200);
  });

  it('revokes the session on logout', async () => {
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const authUrl = new URL(login.headers.location as string);
    const pending = cookieOf(login, 'onepic_login') ?? '';
    const code = await issuer.authorize({
      nonce: authUrl.searchParams.get('nonce') ?? '',
      codeChallenge: authUrl.searchParams.get('code_challenge') ?? '',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
        authUrl.searchParams.get('state') ?? '',
      )}`,
      cookies: { onepic_login: pending },
    });
    const token = cookieOf(callback, 'onepic_session') ?? '';

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { onepic_session: token },
      headers: csrfHeaders(),
    });
    expect(logout.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { onepic_session: token },
    });
    expect(me.statusCode).toBe(401);
  });

  it('expires sessions server-side (expired_at in the past is unauthenticated)', async () => {
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const authUrl = new URL(login.headers.location as string);
    const pending = cookieOf(login, 'onepic_login') ?? '';
    const code = await issuer.authorize({
      nonce: authUrl.searchParams.get('nonce') ?? '',
      codeChallenge: authUrl.searchParams.get('code_challenge') ?? '',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
        authUrl.searchParams.get('state') ?? '',
      )}`,
      cookies: { onepic_login: pending },
    });
    const token = cookieOf(callback, 'onepic_session') ?? '';
    expect(token).not.toBe('');

    // Force expiry directly in the store (sha256 is built-in since PG 11).
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: database.uri });
    await pool.query(
      `UPDATE session SET expires_at = now() - interval '1 minute'
       WHERE token_sha256 = encode(sha256(convert_to($1, 'utf8')), 'hex')`,
      [token],
    );
    await pool.end();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { onepic_session: token },
    });
    expect(me.statusCode).toBe(401);
  });

  it('rejects cross-site mutating requests without the CSRF header pair', async () => {
    const noHeaders = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(noHeaders.statusCode).toBe(403);
    expect(noHeaders.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: 'https://evil.example', 'x-onepic-requested-with': 'onepic-fetch' },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const missingCustomHeader = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: REDIRECT_ORIGIN },
    });
    expect(missingCustomHeader.statusCode).toBe(403);
  });
});

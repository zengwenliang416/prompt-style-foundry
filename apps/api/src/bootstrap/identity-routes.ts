import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { IdentityProviderPort, SessionRepositoryPort } from '../modules/identity/port.js';

/**
 * Identity routes (B03): login (redirect), callback (code exchange →
 * subject upsert → opaque session cookie), me, refresh (rotation), logout
 * (revocation). Cookies are httpOnly + SameSite=Lax; `secure` follows the
 * redirect URI scheme. Errors use the stable error envelope with codes from
 * the D06 catalog (correlationId formalized with B06).
 */

export interface IdentityDeps {
  provider: IdentityProviderPort;
  sessions: SessionRepositoryPort;
  /** Derived from the OIDC redirect URI; also the CSRF allowed origin. */
  allowedOrigin: string;
  secureCookies: boolean;
  pendingCookieName?: string;
  sessionCookieName?: string;
  sessionTtlSeconds?: number;
}

const PENDING_COOKIE = 'onepic_login';
const SESSION_COOKIE = 'onepic_session';

function errorEnvelope(code: string, message: string, correlationId: string): object {
  return { error: { code, message, correlationId } };
}

function cookieToString(
  name: string,
  value: string,
  options: { maxAge?: number; expires?: Date; secure: boolean },
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  const pendingCookieName = deps.pendingCookieName ?? PENDING_COOKIE;
  const sessionCookieName = deps.sessionCookieName ?? SESSION_COOKIE;
  const ttl = deps.sessionTtlSeconds ?? 60 * 60 * 24 * 7;

  /**
   * CSRF guard: browser-originated mutating requests must come from the
   * allowed origin AND carry the custom header (cross-site form posts cannot
   * set custom headers). Applied to every non-GET /api/v1 route.
   */
  const csrfGuard = async (request: { method: string; headers: Record<string, unknown> }, reply: { code(status: number): { send(payload: unknown): unknown } }): Promise<void> => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      return;
    }
    const origin = request.headers['origin'];
    const custom = request.headers['x-onepic-requested-with'];
    const originOk = origin === deps.allowedOrigin;
    const customOk = custom === 'onepic-fetch';
    if (!originOk || !customOk) {
      await reply
        .code(403)
        .send(errorEnvelope('FORBIDDEN', 'Cross-site request rejected', randomUUID()));
    }
  };
  app.addHook('preHandler', csrfGuard);

  app.get('/api/v1/auth/login', async (_request, reply) => {
    const challenge = await deps.provider.createLoginChallenge();
    reply.header(
      'set-cookie',
      cookieToString(pendingCookieName, challenge.challengeId, {
        maxAge: 600,
        secure: deps.secureCookies,
      }),
    );
    await reply.code(302).redirect(challenge.authorizationUrl);
  });

  app.get('/api/v1/auth/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    const cookies = parseCookies(request.headers.cookie);
    const challengeId = cookies[pendingCookieName] ?? '';
    if (code === '' || state === '' || challengeId === '') {
      return await reply
        .code(400)
        .send(errorEnvelope('VALIDATION_FAILED', 'Missing callback parameters', randomUUID()));
    }
    try {
      const identity = await deps.provider.exchangeCode({ code, state, challengeId });
      const subject = await deps.sessions.upsertSubject({
        issuer: identity.issuer,
        subjectClaim: identity.subjectClaim,
      });
      const session = await deps.sessions.create({ subjectId: subject.id, ttlSeconds: ttl });
      reply.header('set-cookie', [
        cookieToString(sessionCookieName, session.token, {
          expires: session.expiresAt,
          secure: deps.secureCookies,
        }),
        cookieToString(pendingCookieName, '', { maxAge: 0, secure: deps.secureCookies }),
      ]);
      return await reply.code(302).redirect('/');
    } catch {
      return await reply
        .code(401)
        .send(errorEnvelope('UNAUTHENTICATED', 'Login failed', randomUUID()));
    }
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[sessionCookieName] ?? '';
    const session = token === '' ? null : await deps.sessions.resolve(token);
    if (session === null) {
      return await reply
        .code(401)
        .send(errorEnvelope('UNAUTHENTICATED', 'No active session', randomUUID()));
    }
    const subject = await deps.sessions.findSubjectById(session.subjectId);
    if (subject === null) {
      return await reply
        .code(401)
        .send(errorEnvelope('UNAUTHENTICATED', 'No active session', randomUUID()));
    }
    return { data: { subject } };
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[sessionCookieName] ?? '';
    const rotated = token === '' ? null : await deps.sessions.rotate(token, ttl);
    if (rotated === null) {
      return await reply
        .code(401)
        .send(errorEnvelope('UNAUTHENTICATED', 'No active session', randomUUID()));
    }
    reply.header(
      'set-cookie',
      cookieToString(sessionCookieName, rotated.token, {
        expires: rotated.expiresAt,
        secure: deps.secureCookies,
      }),
    );
    return { data: { rotated: true } };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[sessionCookieName] ?? '';
    if (token !== '') {
      await deps.sessions.revoke(token);
    }
    reply.header(
      'set-cookie',
      cookieToString(sessionCookieName, '', { maxAge: 0, secure: deps.secureCookies }),
    );
    return { data: { loggedOut: true } };
  });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) {
    return cookies;
  }
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index > 0) {
      cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
  }
  return cookies;
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

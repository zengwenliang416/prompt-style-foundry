import { createHash, randomBytes } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { IdentityProviderPort, LoginChallenge, VerifiedIdentity } from './port.js';

/**
 * OIDC authorization-code + PKCE (S256) adapter (B03). Discovery is fetched
 * from `{issuer}/.well-known/openid-configuration`; ID tokens are verified
 * for signature (remote JWKS), issuer, audience, expiry, and the nonce bound
 * to this specific login challenge. State/PKCE verifiers are kept in an
 * in-memory pending-challenge map with a short TTL — single-node first phase
 * (ADR 0001); a multi-node deployment moves this behind a shared store.
 */

export interface OidcAdapterOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Login challenges expire after this many seconds. */
  challengeTtlSeconds?: number;
  fetchImpl?: typeof fetch;
}

interface PendingChallenge {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

export class OidcAdapter implements IdentityProviderPort {
  private readonly pending = new Map<string, PendingChallenge>();
  private discovery: DiscoveryDocument | null = null;
  private readonly ttlMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: OidcAdapterOptions) {
    this.ttlMs = (options.challengeTtlSeconds ?? 600) * 1000;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  private async getDiscovery(): Promise<DiscoveryDocument> {
    if (this.discovery !== null) {
      return this.discovery;
    }
    const url = new URL(
      '/.well-known/openid-configuration',
      this.options.issuer.endsWith('/') ? this.options.issuer : `${this.options.issuer}/`,
    );
    const response = await this.doFetch(url);
    if (!response.ok) {
      throw new Error('OIDC discovery request failed');
    }
    const document = (await response.json()) as Partial<DiscoveryDocument>;
    if (
      typeof document.authorization_endpoint !== 'string' ||
      typeof document.token_endpoint !== 'string' ||
      typeof document.jwks_uri !== 'string'
    ) {
      throw new Error('OIDC discovery document is missing required endpoints');
    }
    this.discovery = document as DiscoveryDocument;
    return this.discovery;
  }

  async createLoginChallenge(): Promise<LoginChallenge> {
    this.pruneExpired();
    const discovery = await this.getDiscovery();
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    const codeVerifier = base64url(randomBytes(48));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
    const challengeId = base64url(randomBytes(16));

    this.pending.set(challengeId, {
      state,
      nonce,
      codeVerifier,
      createdAt: Date.now(),
    });

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', this.options.clientId);
    authorizationUrl.searchParams.set('redirect_uri', this.options.redirectUri);
    authorizationUrl.searchParams.set('scope', 'openid profile');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    return { authorizationUrl: authorizationUrl.toString(), state, challengeId };
  }

  async exchangeCode(parameters: {
    code: string;
    state: string;
    challengeId: string;
  }): Promise<VerifiedIdentity> {
    this.pruneExpired();
    const challenge = this.pending.get(parameters.challengeId);
    if (challenge === undefined) {
      throw new Error('unknown or expired login challenge');
    }
    // Single use: consume before validating to prevent replay.
    this.pending.delete(parameters.challengeId);
    if (challenge.state !== parameters.state) {
      throw new Error('state mismatch');
    }

    const discovery = await this.getDiscovery();
    const doFetch = this.doFetch;
    const tokenResponse = await doFetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: parameters.code,
        redirect_uri: this.options.redirectUri,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code_verifier: challenge.codeVerifier,
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error('token exchange failed');
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (typeof tokens.id_token !== 'string') {
      throw new Error('token response missing id_token');
    }

    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: this.options.issuer,
      audience: this.options.clientId,
      clockTolerance: 30,
    });
    // jose v6 dropped the nonce option; enforce the replay binding manually.
    if (payload.nonce !== challenge.nonce) {
      throw new Error('nonce mismatch');
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('id_token missing subject');
    }

    return { issuer: this.options.issuer, subjectClaim: payload.sub, nonce: challenge.nonce };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, challenge] of this.pending) {
      if (now - challenge.createdAt > this.ttlMs) {
        this.pending.delete(id);
      }
    }
  }
}

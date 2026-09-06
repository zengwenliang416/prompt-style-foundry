/**
 * Identity domain ports (architecture §4: the domain defines interfaces, the
 * infrastructure implements them). B03 wires an OIDC adapter and a PG-backed
 * session repository behind these ports; nothing in this file may depend on
 * the HTTP framework or a specific provider SDK.
 */

export interface Subject {
  id: string;
  issuer: string;
  subjectClaim: string;
  role: 'guest' | 'member' | 'admin';
}

/** Validated identity from an OIDC ID token. */
export interface VerifiedIdentity {
  issuer: string;
  subjectClaim: string;
  nonce: string;
}

export interface LoginChallenge {
  /** OIDC authorization redirect target. */
  authorizationUrl: string;
  /** Server-side state, verified on callback. */
  state: string;
  /** Pairing handle for the pending login (stored server-side). */
  challengeId: string;
}

export interface SessionRecord {
  id: string;
  subjectId: string;
  expiresAt: Date;
}

/** OIDC provider port: challenge creation and code exchange with validation. */
export interface IdentityProviderPort {
  createLoginChallenge(): Promise<LoginChallenge>;
  /** Exchanges the callback code; enforces state, nonce, issuer, audience. */
  exchangeCode(parameters: {
    code: string;
    state: string;
    challengeId: string;
  }): Promise<VerifiedIdentity>;
}

/** Opaque session repository port (PG-backed in B03). */
export interface SessionRepositoryPort {
  create(input: { subjectId: string; ttlSeconds: number }): Promise<{
    sessionId: string;
    /** Opaque cookie token; the repository persists only its hash. */
    token: string;
    expiresAt: Date;
  }>;
  /** Resolves a presented token; returns null for unknown/expired/revoked. */
  resolve(token: string): Promise<SessionRecord | null>;
  revoke(token: string): Promise<void>;
  /** Rotates a session: new token, old session revoked, lineage recorded. */
  rotate(token: string, ttlSeconds: number): Promise<{ token: string; expiresAt: Date } | null>;
  upsertSubject(input: { issuer: string; subjectClaim: string }): Promise<Subject>;
  findSubjectById(id: string): Promise<Subject | null>;
}

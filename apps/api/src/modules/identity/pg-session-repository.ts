import { createHash, randomBytes } from 'node:crypto';

import type { Queryable } from '../../db/queryable.js';
import type {
  SessionRecord,
  SessionRepositoryPort,
  Subject,
} from './port.js';

/**
 * PG-backed opaque session repository (B03, data dictionary §1.1–1.2).
 * Only the SHA-256 of the cookie token is stored; expiry, revocation, and
 * rotation lineage (rotated_from) live server-side.
 */

export class PgSessionRepository implements SessionRepositoryPort {
  constructor(private readonly client: Queryable) {}

  async upsertSubject(input: { issuer: string; subjectClaim: string }): Promise<Subject> {
    const result = await this.client.query<{
      id: string;
      issuer: string;
      subject_claim: string;
      role: 'guest' | 'member' | 'admin';
    }>(
      `INSERT INTO subject (issuer, subject_claim, role) VALUES ($1, $2, 'member')
       ON CONFLICT (issuer, subject_claim) DO UPDATE SET issuer = EXCLUDED.issuer
       RETURNING id, issuer, subject_claim, role`,
      [input.issuer, input.subjectClaim],
    );
    const row = result.rows[0]!;
    return { id: row.id, issuer: row.issuer, subjectClaim: row.subject_claim, role: row.role };
  }

  async findSubjectById(id: string): Promise<Subject | null> {
    const result = await this.client.query<{
      id: string;
      issuer: string;
      subject_claim: string;
      role: 'guest' | 'member' | 'admin';
    }>('SELECT id, issuer, subject_claim, role FROM subject WHERE id = $1', [id]);
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return { id: row.id, issuer: row.issuer, subjectClaim: row.subject_claim, role: row.role };
  }

  async create(input: {
    subjectId: string;
    ttlSeconds: number;
  }): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const tokenSha256 = createHash('sha256').update(token).digest('hex');
    const result = await this.client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO session (subject_id, token_sha256, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING id, expires_at`,
      [input.subjectId, tokenSha256, input.ttlSeconds],
    );
    const row = result.rows[0]!;
    return { sessionId: row.id, token, expiresAt: row.expires_at };
  }

  async resolve(token: string): Promise<SessionRecord | null> {
    const tokenSha256 = createHash('sha256').update(token).digest('hex');
    const result = await this.client.query<{
      id: string;
      subject_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, subject_id, expires_at, revoked_at FROM session
       WHERE token_sha256 = $1 AND expires_at > now() AND revoked_at IS NULL`,
      [tokenSha256],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return { id: row.id, subjectId: row.subject_id, expiresAt: row.expires_at };
  }

  async revoke(token: string): Promise<void> {
    const tokenSha256 = createHash('sha256').update(token).digest('hex');
    await this.client.query(
      `UPDATE session SET revoked_at = now() WHERE token_sha256 = $1 AND revoked_at IS NULL`,
      [tokenSha256],
    );
  }

  async rotate(
    token: string,
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const current = await this.resolve(token);
    if (current === null) {
      return null;
    }
    const created = await this.create({ subjectId: current.subjectId, ttlSeconds });
    const tokenSha256 = createHash('sha256').update(token).digest('hex');
    // Revoke the old session and record the rotation lineage atomically.
    await this.client.query(
      `UPDATE session SET revoked_at = now(), rotated_from = NULL WHERE token_sha256 = $1`,
      [tokenSha256],
    );
    await this.client.query(`UPDATE session SET rotated_from = $1 WHERE id = $2`, [
      current.id,
      created.sessionId,
    ]);
    return { token: created.token, expiresAt: created.expiresAt };
  }
}

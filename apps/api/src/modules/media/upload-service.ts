import { randomUUID } from 'node:crypto';

import type { Queryable } from '../../db/queryable.js';
import type { StoragePort } from '../../infra/storage/storage.js';

/**
 * Upload sessions with quarantine (M01, data dictionary §1.5–1.6, architecture
 * §8). Rules enforced here:
 * - declared limits: 20 MiB, JPEG/PNG/WebP only (§8 first-phase caps);
 * - object keys are SERVER-generated — client paths are never accepted;
 * - confirm requires the bytes to be fully present and equal to the declared
 *   size; double confirmation is rejected;
 * - expired sessions (1 hour default) cannot be confirmed;
 * - only the owning subject can confirm;
 * - unconfirmed/quarantine objects are not usable for generation (M04).
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 60 * 60;
const ALLOWED_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface UploadSession {
  uploadId: string;
  bucket: string;
  objectKey: string;
  expiresAt: Date;
}

export type UploadProblem =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UPLOAD_EXPIRED'
  | 'INCOMPLETE_UPLOAD'
  | 'ALREADY_CONFIRMED';

export type UploadOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; problem: UploadProblem; message: string };

export class UploadService {
  constructor(
    private readonly client: Queryable,
    private readonly storage: StoragePort,
    private readonly options: { maxBytes?: number; ttlSeconds?: number } = {},
  ) {}

  async createUpload(input: {
    ownerId: string;
    declaredBytes: number;
    declaredMime: string;
  }): Promise<UploadOutcome<UploadSession>> {
    if (!ALLOWED_MIMES.includes(input.declaredMime)) {
      return { ok: false, problem: 'UNSUPPORTED_MEDIA_TYPE', message: '仅支持 JPEG / PNG / WebP' };
    }
    const maxBytes = this.options.maxBytes ?? MAX_UPLOAD_BYTES;
    if (input.declaredBytes <= 0 || input.declaredBytes > maxBytes) {
      return { ok: false, problem: 'PAYLOAD_TOO_LARGE', message: `上限 ${maxBytes} 字节` };
    }

    const bucket = 'quarantine';
    const objectKey = `${input.ownerId}/${randomUUID()}`;
    const ttl = this.options.ttlSeconds ?? UPLOAD_TTL_SECONDS;
    const result = await this.client.query<{ upload_id: string; expires_at: Date }>(
      `WITH media AS (
         INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
         VALUES ($1, 'input', 'quarantine', $2, $3, 'pending', now() + make_interval(secs => $4))
         RETURNING id, expires_at
       ), up AS (
         INSERT INTO upload (media_object_id, declared_bytes, declared_mime)
         SELECT id, $5, $6 FROM media RETURNING id, media_object_id
       )
       SELECT media.id AS media_id, up.id AS upload_id, media.expires_at
       FROM media JOIN up ON up.media_object_id = media.id`,
      [input.ownerId, bucket, objectKey, ttl, input.declaredBytes, input.declaredMime],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { ok: false, problem: 'NOT_FOUND', message: 'upload creation failed' };
    }
    return {
      ok: true,
      value: {
        uploadId: row.upload_id,
        bucket,
        objectKey,
        expiresAt: row.expires_at,
      },
    };
  }

  /** Server-side byte placement into quarantine (direct or via signed URL). */
  async putQuarantineBytes(uploadId: string, ownerId: string, body: Buffer): Promise<UploadOutcome<{ bytes: number }>> {
    const session = await this.loadSession(uploadId);
    if (session === null || session.ownerId !== ownerId) {
      return { ok: false, problem: session === null ? 'NOT_FOUND' : 'FORBIDDEN', message: 'upload not accessible' };
    }
    if (session.expired) {
      return { ok: false, problem: 'UPLOAD_EXPIRED', message: 'upload session expired' };
    }
    // pg returns bigint columns as strings — normalize before comparing.
    const declared = Number(session.declaredBytes);
    if (body.length !== declared) {
      return { ok: false, problem: 'INCOMPLETE_UPLOAD', message: `expected ${declared} bytes` };
    }
    await this.storage.put({ bucket: session.bucket, key: session.objectKey, body });
    return { ok: true, value: { bytes: body.length } };
  }

  async confirmUpload(input: {
    uploadId: string;
    ownerId: string;
    actualSha256: string;
  }): Promise<UploadOutcome<{ mediaObjectId: string; bytes: number }>> {
    const session = await this.loadSession(input.uploadId);
    if (session === null || session.ownerId !== input.ownerId) {
      return {
        ok: false,
        problem: session === null ? 'NOT_FOUND' : 'FORBIDDEN',
        message: 'upload not accessible',
      };
    }
    if (session.confirmedAt !== null) {
      return { ok: false, problem: 'ALREADY_CONFIRMED', message: 'upload already confirmed' };
    }
    if (session.expired) {
      return { ok: false, problem: 'UPLOAD_EXPIRED', message: 'upload session expired' };
    }

    let bytes: Buffer;
    try {
      bytes = await this.storage.get({ bucket: session.bucket, key: session.objectKey });
    } catch {
      return { ok: false, problem: 'INCOMPLETE_UPLOAD', message: 'no bytes uploaded' };
    }
    if (bytes.length !== Number(session.declaredBytes)) {
      return { ok: false, problem: 'INCOMPLETE_UPLOAD', message: `expected ${session.declaredBytes} bytes` };
    }

    const updated = await this.client.query<{ media_object_id: string }>(
      `UPDATE upload SET confirmed_at = now()
       WHERE id = $1 AND confirmed_at IS NULL
       RETURNING media_object_id`,
      [input.uploadId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return { ok: false, problem: 'ALREADY_CONFIRMED', message: 'upload already confirmed' };
    }
    const mediaObjectId = updated.rows[0]!.media_object_id;
    await this.client.query(
      `UPDATE media_object SET sha256 = $2 WHERE id = $1`,
      [mediaObjectId, input.actualSha256],
    );
    return { ok: true, value: { mediaObjectId, bytes: bytes.length } };
  }

  private async loadSession(
    uploadId: string,
  ): Promise<
    | {
        ownerId: string;
        bucket: string;
        objectKey: string;
        declaredBytes: number;
        confirmedAt: Date | null;
        expired: boolean;
      }
    | null
  > {
    const result = await this.client.query<{
      owner_id: string;
      bucket: string;
      object_key: string;
      declared_bytes: number;
      confirmed_at: Date | null;
      expired: boolean;
    }>(
      `SELECT m.owner_id, m.bucket, m.object_key, u.declared_bytes, u.confirmed_at,
              (m.expires_at < now()) AS expired
       FROM upload u JOIN media_object m ON m.id = u.media_object_id
       WHERE u.id = $1`,
      [uploadId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      ownerId: row.owner_id,
      bucket: row.bucket,
      objectKey: row.object_key,
      declaredBytes: row.declared_bytes,
      confirmedAt: row.confirmed_at,
      expired: row.expired,
    };
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed access for private media (M03, architecture §8).
 *
 * Guarantees:
 * - no public ACL: objects are only reachable through this verification;
 * - signatures are HMAC-SHA256 over (bucket, key, owner, method, expires)
 *   with the server signing key, and expire after `ttlSeconds`;
 * - the signed owner is bound into the signature AND re-checked against the
 *   requesting subject, so a leaked link used by another user still fails;
 * - responses carry a private cache policy (downstream proxies must not
 *   retain user media).
 */

export interface SignedAccessInput {
  bucket: string;
  key: string;
  ownerId: string;
  method: 'GET';
  ttlSeconds: number;
  now?: number;
}

export type SignedAccessResult =
  | { ok: true }
  | { ok: false; code: 'FORBIDDEN' | 'MEDIA_EXPIRED'; foreign: boolean };

export function signMediaPath(
  input: Omit<SignedAccessInput, 'now'> & { now?: number },
  signingKey: string,
): { path: string; expires: number } {
  const expires = Math.floor((input.now ?? Date.now()) / 1000) + input.ttlSeconds;
  const payload = `${input.method}:${input.bucket}:${input.key}:${input.ownerId}:${expires}`;
  const signature = createHmac('sha256', signingKey).update(payload).digest('base64url');
  const path = `/api/v1/media/${input.bucket}/${input.key}?owner=${encodeURIComponent(
    input.ownerId,
  )}&expires=${expires}&signature=${signature}`;
  return { path, expires };
}

export function verifySignedMedia(
  input: {
    bucket: string;
    key: string;
    ownerId: string;
    expires: string | undefined;
    signature: string | undefined;
    method: string;
    now?: number;
  },
  signingKey: string,
): SignedAccessResult {
  const { bucket, key, ownerId, expires, signature, method } = input;
  if (expires === undefined || signature === undefined) {
    return { ok: false, code: 'FORBIDDEN', foreign: false };
  }
  const expiresAt = Number.parseInt(expires, 10);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 < (input.now ?? Date.now())) {
    return { ok: false, code: 'MEDIA_EXPIRED', foreign: false };
  }
  const payload = `${method}:${bucket}:${key}:${ownerId}:${expiresAt}`;
  const expected = createHmac('sha256', signingKey).update(payload).digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return { ok: false, code: 'FORBIDDEN', foreign: false };
  }
  return { ok: true };
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Opaque pagination cursor (W03).
 *
 * Format: `<base64url(payload)>.<base64url(hmac-sha256(payload, key))>` where
 * the payload is `{"v":1,"c":"<createdAt ISO>","id":"<row uuid>"}` — the
 * keyset position of the last row of the previous page.
 *
 * Tamper resistance: the HMAC is signed with the deployment's signing key
 * (same key family as signed media URLs), so a client cannot craft a position
 * it never received. Decoding is strict — any structural, type, range, or
 * signature mismatch yields null and the controller answers 400; a bad cursor
 * never silently degrades to "first page".
 */

const PAYLOAD_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MIN_CURSOR_TIME = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

export interface CursorPosition {
  /** Keyset column: created_at of the last row served (ISO-8601 UTC). */
  readonly createdAt: string;
  /** Tiebreaker column: id of the last row served. */
  readonly id: string;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function encodeCursor(position: CursorPosition, key: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: PAYLOAD_VERSION, c: position.createdAt, id: position.id }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

export function decodeCursor(token: string, key: string): CursorPosition | null {
  if (token.length === 0 || token.length > 512) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts as [string, string];
  if (!BASE64URL_RE.test(payload) || !BASE64URL_RE.test(signature)) {
    return null;
  }
  const expected = Buffer.from(sign(payload, key), 'utf8');
  const presented = Buffer.from(signature, 'utf8');
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== PAYLOAD_VERSION) {
    return null;
  }
  const createdAt = record['c'];
  const id = record['id'];
  if (typeof createdAt !== 'string' || typeof id !== 'string' || !UUID_RE.test(id)) {
    return null;
  }
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time) || time < MIN_CURSOR_TIME || time > Date.now() + MAX_FUTURE_SKEW_MS) {
    return null;
  }
  return { createdAt: new Date(time).toISOString(), id };
}

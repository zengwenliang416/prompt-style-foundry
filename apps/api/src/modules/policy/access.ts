import type { Subject } from '../identity/port.js';

/**
 * Object-level authorization decisions (B04, permission matrix in the
 * backend data dictionary §4 / ADR 0001 D-4).
 *
 * Invariants:
 * - unauthenticated actors get nothing beyond the public catalog;
 * - a member accesses ONLY objects whose owner_id matches (users cannot
 *   read or write another user's media, tasks, collections, or download
 *   links — foreign objects are 404s, not 403s, to avoid existence leaks;
 *   the caller maps FORBIDDEN_ON_FOREIGN to 404);
 * - an admin may inspect metadata for operations but has NO default image
 *   read right: read-media is denied for admin on foreign objects too.
 */

export type AccessAction = 'read-metadata' | 'read-media' | 'write';

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; code: 'UNAUTHENTICATED' | 'FORBIDDEN'; foreign: boolean };

export function decideObjectAccess(
  actor: Subject | null,
  ownerId: string,
  action: AccessAction,
): AccessDecision {
  if (actor === null) {
    return { allowed: false, code: 'UNAUTHENTICATED', foreign: false };
  }
  if (actor.id === ownerId) {
    return { allowed: true };
  }
  if (actor.role === 'admin' && action === 'read-metadata') {
    // Admin boundary: metadata visibility for operations only.
    return { allowed: true };
  }
  // Everyone else — including admins on media — is denied as foreign.
  return { allowed: false, code: 'FORBIDDEN', foreign: true };
}

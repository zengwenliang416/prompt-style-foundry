import type { Queryable } from '../../db/queryable.js';
import { decodeCursor, encodeCursor, type CursorPosition } from './cursor.js';

/**
 * Generation history pagination (W03, data dictionary §1.13/§4).
 *
 * Guarantees (acceptance):
 * - a subject only ever pages through its OWN generations (owner filter is
 *   part of the query, not a post-filter);
 * - stable keyset ordering: created_at DESC with id as tiebreaker, so a
 *   concurrent insert lands ahead of page 1 and never reshuffles or
 *   duplicates rows across already-issued pages;
 * - the cursor is opaque and HMAC-signed (cursor.ts): tampered or malformed
 *   tokens are rejected with INVALID_CURSOR → 400, never treated as
 *   "start over";
 * - page size is capped (contract: limit ≤ 50, default 20).
 */

export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 50;

export interface HistoryItem {
  generationId: string;
  state: string;
  errorCode: string | null;
  templateKey: string;
  templateVersion: number;
  createdAt: string;
  completedAt: string | null;
}

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}

export type HistoryListResult =
  { ok: true; value: HistoryPage } | { ok: false; code: 'INVALID_CURSOR' };

interface HistoryRow {
  id: string;
  state: string;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
  template_key: string;
  version: number;
}

export class HistoryService {
  constructor(
    private readonly db: Queryable,
    private readonly config: { signingKey: string },
  ) {}

  async listGenerations(input: {
    subjectId: string;
    state?: string;
    cursor?: string;
    limit?: number;
  }): Promise<HistoryListResult> {
    let position: CursorPosition | null = null;
    if (input.cursor !== undefined) {
      position = decodeCursor(input.cursor, this.config.signingKey);
      if (position === null) {
        return { ok: false, code: 'INVALID_CURSOR' };
      }
    }
    const limit = Math.min(input.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);

    const params: unknown[] = [input.subjectId];
    let where = 'g.owner_id = $1';
    if (input.state !== undefined) {
      params.push(input.state);
      where += ` AND g.state = $${params.length}`;
    }
    if (position !== null) {
      params.push(position.createdAt, position.id);
      where += ` AND (g.created_at, g.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);

    const rows = (
      await this.db.query<HistoryRow>(
        `SELECT g.id, g.state, g.error_code, g.created_at, g.completed_at,
                tv.template_key, tv.version
         FROM generation g JOIN template_version tv ON tv.id = g.template_version_id
         WHERE ${where}
         ORDER BY g.created_at DESC, g.id DESC
         LIMIT $${params.length}`,
        params,
      )
    ).rows;

    const pageRows = rows.slice(0, limit);
    const items = pageRows.map<HistoryItem>((row) => ({
      generationId: row.id,
      state: row.state,
      errorCode: row.error_code,
      templateKey: row.template_key,
      templateVersion: row.version,
      createdAt: new Date(row.created_at).toISOString(),
      completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    }));

    let nextCursor: string | null = null;
    if (rows.length > limit && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeCursor(
        { createdAt: new Date(last.created_at).toISOString(), id: last.id },
        this.config.signingKey,
      );
    }
    return { ok: true, value: { items, nextCursor } };
  }
}

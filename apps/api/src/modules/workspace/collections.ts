import type { Queryable } from '../../db/queryable.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/**
 * Collections / favorites (W03, data dictionary §1.13, permission matrix §4).
 *
 * Guarantees (acceptance):
 * - object-level authorization: every operation loads the collection and
 *   checks owner_id (missing → NOT_FOUND, foreign → FORBIDDEN); a subject
 *   never sees or mutates another subject's collections;
 * - idempotent favoriting: the PK (collection_id, item_type, item_key) makes
 *   a repeated add a no-op — the response replays the ORIGINAL added_at and
 *   no duplicate row ever exists;
 * - favoriting a generation requires that generation to belong to the caller
 *   (foreign → FORBIDDEN, missing → NOT_FOUND); favoriting a template
 *   requires the key to exist in the imported catalog;
 * - deleting a collection removes ONLY the collection row and its member
 *   links (collection_item cascades); generation / media_object / result
 *   rows are never touched;
 * - item removal is idempotent (removed=false when the row did not exist);
 * - list pagination uses the same signed keyset cursor as history
 *   (created_at ASC + id tiebreaker).
 */

export const COLLECTION_DEFAULT_LIMIT = 20;
export const COLLECTION_MAX_LIMIT = 50;
export const COLLECTION_NAME_MAX = 80;

const TEMPLATE_KEY_RE = /^(case-[0-9]+|framework-[0-9]{3})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CollectionItemType = 'template' | 'generation';

export interface CollectionSummaryData {
  id: string;
  name: string;
  createdAt: string;
  itemCount: number;
}

export interface CollectionPage {
  items: CollectionSummaryData[];
  nextCursor: string | null;
}

export interface CollectionItemData {
  collectionId: string;
  itemType: CollectionItemType;
  itemKey: string;
  addedAt: string;
}

export type CollectionProblem =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NAME_CONFLICT'
  | 'INVALID_NAME'
  | 'INVALID_ITEM_KEY'
  | 'INVALID_CURSOR';

export type CollectionResult<T> = { ok: true; value: T } | { ok: false; code: CollectionProblem };

interface CollectionRow {
  id: string;
  owner_id: string;
  name: string;
  created_at: Date;
}

export class CollectionService {
  constructor(
    private readonly db: Queryable,
    private readonly config: { signingKey: string },
  ) {}

  async list(input: {
    subjectId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CollectionResult<CollectionPage>> {
    let position: { createdAt: string; id: string } | null = null;
    if (input.cursor !== undefined) {
      position = decodeCursor(input.cursor, this.config.signingKey);
      if (position === null) {
        return { ok: false, code: 'INVALID_CURSOR' };
      }
    }
    const limit = Math.min(input.limit ?? COLLECTION_DEFAULT_LIMIT, COLLECTION_MAX_LIMIT);

    const params: unknown[] = [input.subjectId];
    let where = 'c.owner_id = $1';
    if (position !== null) {
      params.push(position.createdAt, position.id);
      where += ` AND (c.created_at, c.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);

    const rows = (
      await this.db.query<CollectionRow & { item_count: number }>(
        `SELECT c.id, c.owner_id, c.name, c.created_at,
                (SELECT count(*)::int FROM collection_item ci WHERE ci.collection_id = c.id) AS item_count
         FROM collection c
         WHERE ${where}
         ORDER BY c.created_at ASC, c.id ASC
         LIMIT $${params.length}`,
        params,
      )
    ).rows;

    const pageRows = rows.slice(0, limit);
    const items = pageRows.map<CollectionSummaryData>((row) => ({
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
      itemCount: row.item_count,
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

  async create(input: {
    subjectId: string;
    name: string;
  }): Promise<CollectionResult<CollectionSummaryData>> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > COLLECTION_NAME_MAX) {
      return { ok: false, code: 'INVALID_NAME' };
    }
    try {
      const row = (
        await this.db.query<CollectionRow>(
          `INSERT INTO collection (owner_id, name) VALUES ($1, $2)
           RETURNING id, owner_id, name, created_at`,
          [input.subjectId, name],
        )
      ).rows[0]!;
      return {
        ok: true,
        value: {
          id: row.id,
          name: row.name,
          createdAt: new Date(row.created_at).toISOString(),
          itemCount: 0,
        },
      };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, code: 'NAME_CONFLICT' };
      }
      throw error;
    }
  }

  /** Deletes the collection and member links ONLY — never tasks or media. */
  async remove(input: {
    subjectId: string;
    collectionId: string;
  }): Promise<CollectionResult<{ id: string }>> {
    const owned = await this.loadOwned(input.subjectId, input.collectionId);
    if (!owned.ok) {
      return owned;
    }
    await this.db.query('DELETE FROM collection WHERE id = $1', [input.collectionId]);
    return { ok: true, value: { id: input.collectionId } };
  }

  async addItem(input: {
    subjectId: string;
    collectionId: string;
    itemType: CollectionItemType;
    itemKey: string;
  }): Promise<CollectionResult<CollectionItemData>> {
    const owned = await this.loadOwned(input.subjectId, input.collectionId);
    if (!owned.ok) {
      return owned;
    }

    if (input.itemType === 'template') {
      if (!TEMPLATE_KEY_RE.test(input.itemKey)) {
        return { ok: false, code: 'INVALID_ITEM_KEY' };
      }
      const template = await this.db.query(
        'SELECT 1 FROM template_version WHERE template_key = $1 LIMIT 1',
        [input.itemKey],
      );
      if (template.rows.length === 0) {
        return { ok: false, code: 'NOT_FOUND' };
      }
    } else {
      if (!UUID_RE.test(input.itemKey)) {
        return { ok: false, code: 'INVALID_ITEM_KEY' };
      }
      const generation = (
        await this.db.query<{ owner_id: string }>('SELECT owner_id FROM generation WHERE id = $1', [
          input.itemKey,
        ])
      ).rows[0];
      if (generation === undefined) {
        return { ok: false, code: 'NOT_FOUND' };
      }
      if (generation.owner_id !== input.subjectId) {
        return { ok: false, code: 'FORBIDDEN' };
      }
    }

    // PK (collection_id, item_type, item_key): a repeated favorite is a
    // no-op; the response replays the original added_at either way.
    await this.db.query(
      `INSERT INTO collection_item (collection_id, item_type, item_key)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [input.collectionId, input.itemType, input.itemKey],
    );
    const stored = (
      await this.db.query<{ added_at: Date }>(
        `SELECT added_at FROM collection_item
         WHERE collection_id = $1 AND item_type = $2 AND item_key = $3`,
        [input.collectionId, input.itemType, input.itemKey],
      )
    ).rows[0]!;
    return {
      ok: true,
      value: {
        collectionId: input.collectionId,
        itemType: input.itemType,
        itemKey: input.itemKey,
        addedAt: new Date(stored.added_at).toISOString(),
      },
    };
  }

  async removeItem(input: {
    subjectId: string;
    collectionId: string;
    itemType: CollectionItemType;
    itemKey: string;
  }): Promise<CollectionResult<{ removed: boolean }>> {
    const owned = await this.loadOwned(input.subjectId, input.collectionId);
    if (!owned.ok) {
      return owned;
    }
    const deleted = await this.db.query(
      `DELETE FROM collection_item
       WHERE collection_id = $1 AND item_type = $2 AND item_key = $3`,
      [input.collectionId, input.itemType, input.itemKey],
    );
    return { ok: true, value: { removed: (deleted.rowCount ?? 0) > 0 } };
  }

  private async loadOwned(
    subjectId: string,
    collectionId: string,
  ): Promise<CollectionResult<CollectionRow>> {
    if (!UUID_RE.test(collectionId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const row = (
      await this.db.query<CollectionRow>(
        'SELECT id, owner_id, name, created_at FROM collection WHERE id = $1',
        [collectionId],
      )
    ).rows[0];
    if (row === undefined) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (row.owner_id !== subjectId) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    return { ok: true, value: row };
  }
}

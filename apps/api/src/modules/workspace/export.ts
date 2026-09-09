import type { Queryable } from '../../db/queryable.js';
import { HISTORY_MAX_LIMIT, HistoryService } from './history.js';

/**
 * Workspace export (W04, data dictionary §2: GET /exports/workspace).
 *
 * The exported document follows backend-schemas/workspace-export.schema.json
 * exactly and contains ONLY records owned by the requesting subject:
 * - favorites: distinct template ids favorited in any of the subject's
 *   collections;
 * - collections: the subject's collections with their member links;
 * - history: the subject's complete generation history — internally paged
 *   through the W03 keyset cursor (HistoryService) until exhaustion rather
 *   than returning only the first page.
 *
 * No secrets ever enter the document: the queries select only the whitelisted
 * columns below (names, item links, task summaries) — never session tokens,
 * provider keys, prompt bodies, hashes, or signing material, and the route's
 * response schema strips anything undeclared.
 */

export const WORKSPACE_EXPORT_SCHEMA_VERSION = '1.0.0';

export interface WorkspaceExportData {
  schemaVersion: string;
  exportedAt: string;
  favorites: string[];
  collections: Array<{
    name: string;
    items: Array<{ itemType: 'template' | 'generation'; itemKey: string }>;
  }>;
  history: Array<{
    generationId: string;
    templateId: string;
    state: string;
    createdAt: string;
  }>;
}

export class WorkspaceExportService {
  private readonly history: HistoryService;

  constructor(
    private readonly db: Queryable,
    config: { signingKey: string },
  ) {
    this.history = new HistoryService(db, config);
  }

  async export(input: { subjectId: string }): Promise<WorkspaceExportData> {
    const favorites = (
      await this.db.query<{ item_key: string }>(
        `SELECT DISTINCT ci.item_key
         FROM collection_item ci JOIN collection c ON c.id = ci.collection_id
         WHERE c.owner_id = $1 AND ci.item_type = 'template'
         ORDER BY ci.item_key`,
        [input.subjectId],
      )
    ).rows.map((row) => row.item_key);

    const collections = (
      await this.db.query<{
        name: string;
        item_type: 'template' | 'generation' | null;
        item_key: string | null;
      }>(
        `SELECT c.name, ci.item_type, ci.item_key
         FROM collection c
         LEFT JOIN collection_item ci ON ci.collection_id = c.id
         WHERE c.owner_id = $1
         ORDER BY c.created_at ASC, c.id ASC, ci.added_at ASC, ci.item_key ASC`,
        [input.subjectId],
      )
    ).rows.reduce<WorkspaceExportData['collections']>((acc, row) => {
      let entry = acc[acc.length - 1];
      if (entry === undefined || entry.name !== row.name) {
        entry = { name: row.name, items: [] };
        acc.push(entry);
      }
      // LEFT JOIN yields a null member for empty collections.
      if (row.item_type !== null && row.item_key !== null) {
        entry.items.push({ itemType: row.item_type, itemKey: row.item_key });
      }
      return acc;
    }, []);

    // Full keyset walk (W03 cursor), never just the first page.
    const history: WorkspaceExportData['history'] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.history.listGenerations({
        subjectId: input.subjectId,
        limit: HISTORY_MAX_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.ok) {
        throw new Error('export history pagination failed on a server-issued cursor');
      }
      for (const item of page.value.items) {
        history.push({
          generationId: item.generationId,
          templateId: item.templateKey,
          state: item.state,
          createdAt: item.createdAt,
        });
      }
      if (page.value.nextCursor === null) {
        break;
      }
      cursor = page.value.nextCursor;
    }

    return {
      schemaVersion: WORKSPACE_EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      favorites,
      collections,
      history,
    };
  }
}

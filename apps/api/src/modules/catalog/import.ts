import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Queryable } from '../../db/queryable.js';

/**
 * Immutable catalog release import (B02, data dictionary §1.3–1.4).
 *
 * Source of truth is the build pipeline output (public/data/catalog.json plus
 * the shipped prompt TXT files and data/library/templates.json). The importer
 * only READS those files — the source tree is never written (AGENTS §2).
 *
 * Hash discipline (acceptance: 哈希不符拒绝):
 * - every template's shipped prompt body must hash to the catalog's
 *   promptSha256 (build `stable_digest` semantics: trailing newlines
 *   stripped); any mismatch aborts the whole import;
 * - the release's library_sha256 is the sha256 of templates.json bytes and is
 *   the idempotency anchor: re-importing the same library returns the
 *   existing release untouched.
 */

export interface ImportCatalogOptions {
  /** Transaction-capable client (pg Client, Pool, or PoolClient). */
  client: Queryable;
  /** Directory containing data/ and the library file. Defaults to repo root. */
  rootDir?: string;
}

export interface ImportCatalogResult {
  releaseId: string;
  librarySha256: string;
  templateCount: number;
  /** False when the release already existed (idempotent re-import). */
  created: boolean;
}

export class ImportHashMismatchError extends Error {
  readonly mismatches: Array<{ templateId: string; expected: string; actual: string }>;

  constructor(mismatches: Array<{ templateId: string; expected: string; actual: string }>) {
    super(
      `prompt hash mismatch for ${mismatches.length} template(s): ${mismatches
        .map((m) => m.templateId)
        .join(', ')}`,
    );
    this.name = 'ImportHashMismatchError';
    this.mismatches = mismatches;
  }
}

export class ImportSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportSchemaError';
  }
}

interface CatalogTemplate {
  id: string;
  title: string;
  kind: string;
  category: string;
  styles: string[];
  scenes: string[];
  tags: string[];
  language: string;
  mode: string;
  blueprintInputMode: string;
  requiresText: boolean;
  promptPath: string;
  promptSha256: string;
  source: unknown;
}

interface CatalogDocument {
  schemaVersion: string;
  source: { archiveSha256: string };
  stats: { total: number };
  templates: CatalogTemplate[];
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Build `stable_digest` semantics: hash the body without trailing newlines. */
export function stablePromptBody(text: string): string {
  return text.replace(/\n+$/, '');
}

function extractBlueprintSha256(promptText: string): string {
  const begin = promptText.indexOf('BEGIN VISUAL BLUEPRINT');
  const end = promptText.indexOf('END VISUAL BLUEPRINT');
  if (begin < 0 || end < 0 || end < begin) {
    return sha256Hex('');
  }
  return sha256Hex(stablePromptBody(promptText.slice(begin, end + 'END VISUAL BLUEPRINT'.length)));
}

export interface ImportCatalogOptions {
  client: Queryable;
  /** Directory containing data/ and the library file. Defaults to repo root. */
  rootDir?: string;
  /** Actor recorded on audit events (maintenance subject id, if known). */
  actorId?: string;
}

export interface VersionChange {
  templateKey: string;
  version: number;
  previousCompiledPromptSha256: string | null;
  compiledPromptSha256: string;
}

export async function importCatalogRelease(
  options: ImportCatalogOptions,
): Promise<ImportCatalogResult & { changes: VersionChange[] }> {
  const root = options.rootDir ?? fileURLToPath(new URL('../../../../', import.meta.url));
  const catalogBytes = await readFile(path.join(root, 'public/data/catalog.json'));
  const catalog = JSON.parse(catalogBytes.toString('utf8')) as CatalogDocument;
  if (
    typeof catalog.schemaVersion !== 'string' ||
    !Array.isArray(catalog.templates) ||
    typeof catalog.source?.archiveSha256 !== 'string'
  ) {
    throw new ImportSchemaError('catalog.json does not match the expected shape');
  }

  const libraryBytes = await readFile(path.join(root, 'data/library/templates.json'));
  const librarySha256 = sha256Hex(libraryBytes);

  // Verify every shipped prompt against its catalog hash BEFORE writing.
  const mismatches: Array<{ templateId: string; expected: string; actual: string }> = [];
  const promptBodies = new Map<string, string>();
  for (const template of catalog.templates) {
    if (
      typeof template.id !== 'string' ||
      typeof template.promptPath !== 'string' ||
      !template.promptPath.startsWith('data/prompts/') ||
      typeof template.promptSha256 !== 'string'
    ) {
      throw new ImportSchemaError(`template ${String(template.id)} has invalid prompt fields`);
    }
    const text = await readFile(path.join(root, 'public', template.promptPath), 'utf8');
    const actual = sha256Hex(stablePromptBody(text));
    if (actual !== template.promptSha256) {
      mismatches.push({ templateId: template.id, expected: template.promptSha256, actual });
    }
    promptBodies.set(template.id, text);
  }
  if (mismatches.length > 0) {
    throw new ImportHashMismatchError(mismatches);
  }

  // Idempotency anchor: identical library content means identical release.
  const existing = await options.client.query<{ id: string; template_count: number }>(
    'SELECT id, template_count FROM catalog_release WHERE library_sha256 = $1',
    [librarySha256],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    return {
      releaseId: row.id,
      librarySha256,
      templateCount: row.template_count,
      created: false,
      changes: [],
    };
  }

  const changes: VersionChange[] = [];
  await options.client.query('BEGIN');
  try {
    const release = await options.client.query<{ id: string }>(
      `INSERT INTO catalog_release (schema_version, source_sha256, library_sha256, template_count)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [catalog.schemaVersion, catalog.source.archiveSha256, librarySha256, catalog.templates.length],
    );
    const releaseId = release.rows[0]!.id;

    for (const template of catalog.templates) {
      const promptText = promptBodies.get(template.id) ?? '';

      // (template_key, compiled_prompt_sha256) is unique: unchanged content
      // reuses the existing immutable version row instead of forking one.
      const sameContent = await options.client.query<{ id: string }>(
        `SELECT id FROM template_version
         WHERE template_key = $1 AND compiled_prompt_sha256 = $2 LIMIT 1`,
        [template.id, template.promptSha256],
      );
      const previousSha =
        (
          await options.client.query<{ compiled_prompt_sha256: string }>(
            `SELECT compiled_prompt_sha256 FROM template_version
             WHERE template_key = $1 ORDER BY version DESC LIMIT 1`,
            [template.id],
          )
        ).rows[0]?.compiled_prompt_sha256 ?? null;
      if (sameContent.rows.length > 0) {
        continue;
      }

      const versionRow = await options.client.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM template_version WHERE template_key = $1`,
        [template.id],
      );
      const nextVersion = versionRow.rows[0]!.next;
      await options.client.query(
        `INSERT INTO template_version (catalog_release_id, template_key, version,
           compiled_prompt_sha256, blueprint_sha256, metadata, prompt_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          releaseId,
          template.id,
          nextVersion,
          template.promptSha256,
          extractBlueprintSha256(promptText),
          JSON.stringify({
            title: template.title,
            kind: template.kind,
            category: template.category,
            styles: template.styles,
            scenes: template.scenes,
            tags: template.tags,
            language: template.language,
            mode: template.mode,
            blueprintInputMode: template.blueprintInputMode,
            requiresText: template.requiresText,
            source: template.source,
          }),
          promptText,
        ],
      );
      // M05: the maintenance flow keeps a hash-level diff trail (no prompt
      // bodies in the audit log) so version history stays reviewable.
      changes.push({
        templateKey: template.id,
        version: nextVersion,
        previousCompiledPromptSha256: previousSha,
        compiledPromptSha256: template.promptSha256,
      });
      await options.client.query(
        `INSERT INTO audit_event (actor_id, action, object_type, object_id, detail)
         VALUES ($1, 'template_version_created', 'template_version', $2, $3)`,
        [
          options.actorId ?? null,
          `${template.id}@${nextVersion}`,
          JSON.stringify({
            previousCompiledPromptSha256: previousSha,
            compiledPromptSha256: template.promptSha256,
            catalogReleaseId: releaseId,
          }),
        ],
      );
    }

    await options.client.query('COMMIT');
    return {
      releaseId,
      librarySha256,
      templateCount: catalog.templates.length,
      created: true,
      changes,
    };
  } catch (error) {
    await options.client.query('ROLLBACK');
    throw error;
  }
}

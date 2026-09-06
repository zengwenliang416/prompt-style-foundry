import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClientConfig } from 'pg';

import type { Queryable } from './queryable.js';

/**
 * Versioned SQL migration runner (B01).
 *
 * - Migrations live in `apps/api/migrations` as `NNNN_name.sql` and run in
 *   lexicographic-numeric order, each inside its own transaction together
 *   with the `schema_migrations` bookkeeping row.
 * - Re-running is a no-op for already-applied versions; `to` upgrades an
 *   existing database incrementally.
 * - Failures abort that migration's transaction and surface the error.
 */

export interface MigrationRecord {
  version: number;
  name: string;
}

export interface RunMigrationsOptions {
  /** Override the migrations directory (defaults to apps/api/migrations). */
  migrationsDir?: string;
  /** Stop after applying this version (inclusive). */
  to?: number;
  client?: Queryable;
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

// ESM-safe: __dirname does not exist in the compiled output; under test
// runners the import URL may be virtual, so fall back to the repository path.
function defaultMigrationsDir(): string {
  try {
    return fileURLToPath(new URL('../../migrations', import.meta.url));
  } catch {
    return path.resolve('apps/api/migrations');
  }
}

async function loadMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(entry);
    if (match === null) {
      continue;
    }
    const version = Number.parseInt(match[1]!, 10);
    const sql = await readFile(path.join(migrationsDir, entry), 'utf8');
    files.push({ version, name: entry, sql });
  }
  files.sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new Error(`duplicate migration version: ${file.version}`);
    }
    seen.add(file.version);
  }
  return files;
}

/**
 * Applies pending migrations. When `client` is omitted a short-lived pg
 * client is created from the connection string.
 */
export async function runMigrations(
  connectionString: string,
  options: RunMigrationsOptions = {},
): Promise<MigrationRecord[]> {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const to = options.to;
  const client = options.client;
  const files = (await loadMigrationFiles(migrationsDir)).filter(
    (file) => to === undefined || file.version <= to,
  );

  const pg = await import('pg');
  const ownClient = client === undefined ? new pg.Client({ connectionString } as ClientConfig) : null;
  const runner = (client ?? (ownClient as unknown as Queryable)) as Queryable;
  try {
    if (ownClient !== null) {
      await ownClient.connect();
    }
    await runner.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedRows = await runner.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const applied = new Set(appliedRows.rows.map((row: { version: number }) => row.version));
    const newlyApplied: MigrationRecord[] = [];

    for (const file of files) {
      if (applied.has(file.version)) {
        continue;
      }
      await runner.query('BEGIN');
      try {
        await runner.query(file.sql);
        await runner.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          file.version,
          file.name,
        ]);
        await runner.query('COMMIT');
        newlyApplied.push({ version: file.version, name: file.name });
      } catch (error) {
        await runner.query('ROLLBACK');
        throw new Error(`migration ${file.version}_${file.name} failed`, { cause: error });
      }
    }
    return newlyApplied;
  } finally {
    if (ownClient !== null) {
      await ownClient.end();
    }
  }
}

export async function appliedVersions(connectionString: string): Promise<number[]> {
  const pg = await import('pg');
  const client = new pg.Client({ connectionString } as ClientConfig);
  try {
    await client.connect();
    const rows = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    return rows.rows.map((row) => row.version);
  } finally {
    await client.end();
  }
}

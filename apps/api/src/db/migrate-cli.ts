import { loadConfig } from '../config/env.js';
import { appliedVersions, runMigrations } from './migrate.js';

/**
 * Migration CLI: `DATABASE_URL=postgresql://… node dist/db/migrate-cli.js`.
 * DATABASE_URL is validated by the shared config loader (managed-mode rules
 * do not apply here; the URL shape is checked and never printed).
 */

const config = loadConfig(process.env);
if (config.databaseUrl === undefined) {
  console.error(
    JSON.stringify({
      event: 'migrate_missing_database_url',
      problem: 'DATABASE_URL is required (postgresql:// URL)',
    }),
  );
  process.exit(1);
}

try {
  const applied = await runMigrations(config.databaseUrl);
  console.log(
    JSON.stringify({
      event: 'migrate_done',
      applied: applied.map((migration) => migration.version),
    }),
  );
  const versions = await appliedVersions(config.databaseUrl);
  console.log(JSON.stringify({ event: 'migrate_state', versions }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'migrate_failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}

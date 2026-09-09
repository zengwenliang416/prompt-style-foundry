import path from 'node:path';

import { Client } from 'pg';

import { defaultCatalogRoot, importCatalogRelease } from './import.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required for catalog import');
  }

  const rootDir = path.resolve(process.env.CATALOG_ROOT ?? defaultCatalogRoot());
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await importCatalogRelease({ client, rootDir });
    process.stdout.write(
      `${JSON.stringify({
        event: 'catalog_imported',
        created: result.created,
        releaseId: result.releaseId,
        librarySha256: result.librarySha256,
        templateCount: result.templateCount,
        versionChanges: result.changes.length,
      })}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown catalog import failure';
  process.stderr.write(`${JSON.stringify({ event: 'catalog_import_failed', message })}\n`);
  process.exitCode = 1;
});

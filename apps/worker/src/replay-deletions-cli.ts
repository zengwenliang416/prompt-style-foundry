import { LocalDiskStorage } from '@onepic/managed-runtime';
import { Pool } from 'pg';

import { logEvent } from './logging.js';
import { replayDeletionManifest } from './replay-deletions.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = required('DATABASE_URL');
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use postgresql://');
  }
  const storageRoot = required('MEDIA_STORAGE_ROOT');
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const report = await replayDeletionManifest(pool, new LocalDiskStorage(storageRoot), { apply });
    logEvent('deletion_manifest_replay', {
      mode: apply ? 'apply' : 'dry-run',
      scanned: report.scanned,
      removalAttempts: report.removalAttempts,
      batches: report.batches,
      failures: report.failures.length,
    });
    if (report.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logEvent('deletion_manifest_replay_failed', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

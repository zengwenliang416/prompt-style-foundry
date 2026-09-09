#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';

import { buildApp } from '../apps/api/dist/bootstrap/app.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { runMigrations, appliedVersions } from '../apps/api/dist/db/migrate.js';
import { LocalDiskStorage } from '../packages/managed-runtime/dist/index.js';
import { startPgTestCluster } from '../packages/test-support/dist/index.js';

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(import.meta.dirname, '..');
const reportPath = path.resolve(
  process.env.ONEPIC_RECOVERY_REPORT ?? '.tmp/o07-recovery-report.json',
);
const pgBin = process.env.ONEPIC_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function inspectWorkspace() {
  const [commit, status] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: ROOT }),
    execFile('git', ['status', '--porcelain'], { cwd: ROOT }),
  ]);
  return {
    commit: commit.stdout.trim(),
    dirty: status.stdout.length > 0,
  };
}

async function resolvePreviousRelease() {
  const explicitlyConfigured = process.env.ONEPIC_PREVIOUS_RELEASE_REF !== undefined;
  const ref = explicitlyConfigured ? process.env.ONEPIC_PREVIOUS_RELEASE_REF : 'HEAD^';
  const refSource = explicitlyConfigured
    ? 'environment:ONEPIC_PREVIOUS_RELEASE_REF'
    : 'default:HEAD^';
  if (ref.length === 0) {
    throw new Error('ONEPIC_PREVIOUS_RELEASE_REF must not be empty when it is set');
  }
  try {
    const resolved = await execFile(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { cwd: ROOT },
    );
    return { ref, refSource, revision: resolved.stdout.trim() };
  } catch {
    throw new Error(`previous release ref from ${refSource} does not resolve to a commit`);
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate loopback port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function withClient(uri, work) {
  const client = new Client({ connectionString: uri });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function seedVersion3(uri) {
  return await withClient(uri, async (client) => {
    await client.query('BEGIN');
    try {
      const subjectId = (
        await client.query(
          `INSERT INTO subject (issuer, subject_claim, role)
           VALUES ('https://recovery.invalid', 'o07-member', 'member') RETURNING id`,
        )
      ).rows[0].id;
      const releaseId = (
        await client.query(
          `INSERT INTO catalog_release
             (schema_version, source_sha256, library_sha256, template_count)
           VALUES ('1.1.0', $1, $2, 1) RETURNING id`,
          ['1'.repeat(64), '2'.repeat(64)],
        )
      ).rows[0].id;
      const templateId = (
        await client.query(
          `INSERT INTO template_version
             (catalog_release_id, template_key, version, compiled_prompt_sha256, blueprint_sha256, metadata)
           VALUES ($1, 'case-532', 1, $2, $3, $4) RETURNING id`,
          [releaseId, '3'.repeat(64), '4'.repeat(64), { title: 'O07 compatibility template' }],
        )
      ).rows[0].id;
      const deletedMediaId = (
        await client.query(
          `INSERT INTO media_object
             (owner_id, kind, state, bucket, object_key, mime, bytes, width, height, sha256, expires_at)
           VALUES ($1, 'result', 'deleted', 'private', 'deleted/o07-result.webp',
                   'image/webp', 12, 1, 1, $2, now() + interval '1 day') RETURNING id`,
          [subjectId, '5'.repeat(64)],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO deletion_manifest (media_object_id, reason) VALUES ($1, 'user_delete')`,
        [deletedMediaId],
      );
      const inputMediaId = (
        await client.query(
          `INSERT INTO media_object
             (owner_id, kind, state, bucket, object_key, mime, bytes, width, height, sha256, expires_at)
           VALUES ($1, 'input', 'ready', 'private', 'input/o07.png',
                   'image/png', 68, 1, 1, $2, now() + interval '1 day') RETURNING id`,
          [subjectId, '6'.repeat(64)],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO upload (media_object_id, declared_bytes, declared_mime, confirmed_at)
         VALUES ($1, 68, 'image/png', now())`,
        [inputMediaId],
      );
      const precheckId = (
        await client.query(
          `INSERT INTO precheck
             (subject_id, media_object_id, template_version_id, settings, result, expires_at)
           VALUES ($1, $2, $3, '{}', 'passed', now() + interval '1 day') RETURNING id`,
          [subjectId, inputMediaId, templateId],
        )
      ).rows[0].id;
      const generationId = (
        await client.query(
          `INSERT INTO generation
             (owner_id, template_version_id, catalog_release_id, precheck_id, input_object_id,
              input_sha256, compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
              settings, idempotency_key, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'o07-provider', 'o07-model',
                   '{}', 'o07-v3-generation', 'created') RETURNING id`,
          [
            subjectId,
            templateId,
            releaseId,
            precheckId,
            inputMediaId,
            '6'.repeat(64),
            '3'.repeat(64),
          ],
        )
      ).rows[0].id;
      await client.query('COMMIT');
      return {
        subjectId,
        releaseId,
        templateId,
        deletedMediaId,
        inputMediaId,
        precheckId,
        generationId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function snapshot(uri) {
  return await withClient(uri, async (client) => {
    const versions = (
      await client.query('SELECT version FROM schema_migrations ORDER BY version')
    ).rows.map((row) => row.version);
    const counts = (
      await client.query(`SELECT
        (SELECT count(*)::int FROM subject) AS subjects,
        (SELECT count(*)::int FROM template_version) AS templates,
        (SELECT count(*)::int FROM media_object) AS media,
        (SELECT count(*)::int FROM generation) AS generations,
        (SELECT count(*)::int FROM deletion_manifest) AS deletion_manifests`)
    ).rows[0];
    const oldProjection = (
      await client.query(
        `SELECT id, owner_id, template_version_id, input_object_id, input_sha256,
                compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
                settings, idempotency_key, state
           FROM generation ORDER BY id`,
      )
    ).rows;
    return { versions, counts, oldProjection };
  });
}

async function oldApplicationContractProbe(uri, ids) {
  return await withClient(uri, async (client) => {
    const before = await snapshotWithClient(client);
    const inserted = await client.query(
      `INSERT INTO generation
         (owner_id, template_version_id, catalog_release_id, precheck_id, input_object_id,
          input_sha256, compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
          settings, idempotency_key, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'o07-provider', 'o07-model',
               '{}', $8, 'created') RETURNING id, state`,
      [
        ids.subjectId,
        ids.templateId,
        ids.releaseId,
        ids.precheckId,
        ids.inputMediaId,
        '6'.repeat(64),
        '3'.repeat(64),
        `o07-old-app-${randomUUID()}`,
      ],
    );
    const after = await snapshotWithClient(client);
    return {
      oldProjectionReadable: before.oldProjection.length >= 1,
      oldInsertWithoutNewColumns: inserted.rows[0].state === 'created',
      generationCountBefore: before.oldProjection.length,
      generationCountAfter: after.oldProjection.length,
    };
  });
}

async function snapshotWithClient(client) {
  const oldProjection = (
    await client.query(
      `SELECT id, owner_id, template_version_id, input_object_id, input_sha256,
              compiled_prompt_sha256, effective_prompt_sha256, provider_id, model,
              settings, idempotency_key, state
         FROM generation ORDER BY id`,
    )
  ).rows;
  return { oldProjection };
}

async function dumpDatabase(uri, destination) {
  await execFile(path.join(pgBin, 'pg_dump'), [
    '--dbname',
    uri,
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    destination,
  ]);
  const bytes = await readFile(destination);
  if (bytes.length === 0) throw new Error('pg_dump produced an empty backup');
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function restoreDatabase(uri, backup) {
  await execFile(path.join(pgBin, 'pg_restore'), [
    '--dbname',
    uri,
    '--no-owner',
    '--no-privileges',
    '--exit-on-error',
    backup,
  ]);
}

async function verifyOldFrontend(tempRoot, previousRelease) {
  const archive = path.join(
    tempRoot,
    `previous-public-${previousRelease.revision.slice(0, 12)}.tar`,
  );
  const checkout = path.join(tempRoot, 'previous-release');
  await mkdir(checkout, { recursive: true });
  await execFile(
    'git',
    ['archive', '--format=tar', `--output=${archive}`, previousRelease.revision, 'public'],
    { cwd: ROOT },
  );
  await execFile('tar', ['-xf', archive, '-C', checkout]);
  const port = await freePort();
  const server = spawn(
    'python3',
    [
      '-m',
      'http.server',
      String(port),
      '--bind',
      '127.0.0.1',
      '--directory',
      path.join(checkout, 'public'),
    ],
    { stdio: 'ignore' },
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // wait for the loopback-only fixture server
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('previous release static frontend did not start');
    const [index, catalog, prompt] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${port}/data/catalog.json`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/data/prompts/case-532.txt`).then((response) =>
        response.text(),
      ),
    ]);
    return {
      requestedRef: previousRelease.ref,
      refSource: previousRelease.refSource,
      revision: previousRelease.revision,
      archive: {
        format: 'git-archive-tar',
        path: 'public',
        revision: previousRelease.revision,
        requestedRef: previousRelease.ref,
        refSource: previousRelease.refSource,
      },
      indexLoaded: index.includes('OnePic Template Studio'),
      catalogTemplates: catalog.templates.length,
      promptLoaded: prompt.includes('BEGIN VISUAL BLUEPRINT'),
    };
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
  }
}

async function verifyCurrentApi(uri, storageRoot) {
  const config = loadConfig({
    HOST: '127.0.0.1',
    PORT: '8080',
    LOG_LEVEL: 'fatal',
    RUN_MODE: 'catalog-only',
    DATABASE_URL: uri,
    MEDIA_STORAGE_ROOT: storageRoot,
  });
  const app = buildApp(config);
  try {
    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    return { liveStatus: live.statusCode, readyStatus: ready.statusCode };
  } finally {
    await app.close();
  }
}
async function runDeletionReplayCli(uri, storageRoot, apply) {
  const args = [path.join(ROOT, 'apps/worker/dist/replay-deletions-cli.js')];
  if (apply) args.push('--apply');
  const result = await execFile(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: uri, MEDIA_STORAGE_ROOT: storageRoot },
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines.at(-1));
  if (parsed.event !== 'deletion_manifest_replay') {
    throw new Error('deletion replay CLI returned an unexpected event');
  }
  return parsed;
}

async function migrationPolicy() {
  const migrationDir = path.join(ROOT, 'apps/api/migrations');
  const files = (await execFile('find', [migrationDir, '-maxdepth', '1', '-name', '*.sql'])).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  const destructive = [];
  for (const file of files) {
    const sql = await readFile(file, 'utf8');
    const withoutComments = sql.replace(/^\s*--.*$/gm, '');
    if (/\b(?:DROP|TRUNCATE)\b/i.test(withoutComments)) destructive.push(path.basename(file));
  }
  return { files: files.map((file) => path.basename(file)), destructive };
}

async function main() {
  const startedAt = new Date();
  const [workspace, previousRelease] = await Promise.all([
    inspectWorkspace(),
    resolvePreviousRelease(),
  ]);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'onepic-recovery-'));
  const storageRoot = path.join(tempRoot, 'object-store');
  const cluster = await startPgTestCluster({ binDir: pgBin });
  try {
    const source = await cluster.createDatabase('o07_source_v3');
    await runMigrations(source.uri, { to: 3 });
    const ids = await seedVersion3(source.uri);
    const sourceSnapshot = await snapshot(source.uri);
    const v3BackupPath = path.join(tempRoot, 'onepic-v3.dump');
    const v3Backup = await dumpDatabase(source.uri, v3BackupPath);

    const restored = await cluster.createDatabase('o07_restored_v3');
    await restoreDatabase(restored.uri, v3BackupPath);
    const restoredSnapshot = await snapshot(restored.uri);
    if (JSON.stringify(restoredSnapshot) !== JSON.stringify(sourceSnapshot)) {
      throw new Error('restored v3 database does not match the backup source');
    }

    await runMigrations(restored.uri);
    const latestVersions = await appliedVersions(restored.uri);
    if (latestVersions.join(',') !== '1,2,3,4,5')
      throw new Error('latest migration set is incomplete');
    const oldContract = await oldApplicationContractProbe(restored.uri, ids);
    if (!oldContract.oldProjectionReadable || !oldContract.oldInsertWithoutNewColumns) {
      throw new Error('previous application contract failed after expand migration');
    }
    const policy = await migrationPolicy();
    if (policy.destructive.length > 0)
      throw new Error('destructive SQL detected in current migrations');

    const latestBackupPath = path.join(tempRoot, 'onepic-v5.dump');
    const latestSourceSnapshot = await snapshot(restored.uri);
    const latestBackup = await dumpDatabase(restored.uri, latestBackupPath);
    const disasterRestore = await cluster.createDatabase('o07_disaster_restore');
    await restoreDatabase(disasterRestore.uri, latestBackupPath);
    const latestRestoredSnapshot = await snapshot(disasterRestore.uri);
    if (JSON.stringify(latestRestoredSnapshot) !== JSON.stringify(latestSourceSnapshot)) {
      throw new Error('latest disaster restore does not match its backup source');
    }

    const storage = new LocalDiskStorage(storageRoot);
    await storage.put({
      bucket: 'private',
      key: 'deleted/o07-result.webp',
      body: Buffer.from('stale'),
    });
    const dryRun = await runDeletionReplayCli(disasterRestore.uri, storageRoot, false);
    const bytesBeforeApply = await storage.size({
      bucket: 'private',
      key: 'deleted/o07-result.webp',
    });
    const apply = await runDeletionReplayCli(disasterRestore.uri, storageRoot, true);
    let absentAfterApply = false;
    try {
      await storage.size({ bucket: 'private', key: 'deleted/o07-result.webp' });
    } catch {
      absentAfterApply = true;
    }
    const repeat = await runDeletionReplayCli(disasterRestore.uri, storageRoot, true);
    const replay = { dryRun, bytesBeforeApply, apply, absentAfterApply, repeat };
    if (
      replay.dryRun.mode !== 'dry-run' ||
      replay.dryRun.scanned !== 1 ||
      replay.dryRun.removalAttempts !== 0 ||
      replay.apply.mode !== 'apply' ||
      replay.apply.scanned !== 1 ||
      replay.apply.removalAttempts !== 1 ||
      replay.apply.failures !== 0 ||
      !replay.absentAfterApply ||
      replay.repeat.failures !== 0
    ) {
      throw new Error('deletion manifest replay CLI was not safe and idempotent');
    }

    const oldFrontend = await verifyOldFrontend(tempRoot, previousRelease);
    if (!oldFrontend.indexLoaded || !oldFrontend.promptLoaded || oldFrontend.catalogTemplates < 1) {
      throw new Error('previous static frontend compatibility probe failed');
    }
    const api = await verifyCurrentApi(disasterRestore.uri, storageRoot);
    if (api.liveStatus !== 200 || api.readyStatus !== 200) {
      throw new Error('restored database did not pass API health checks');
    }
    const rollbackVersions = await appliedVersions(restored.uri);
    if (rollbackVersions.join(',') !== '1,2,3,4,5') {
      throw new Error('application rollback probe unexpectedly changed schema versions');
    }

    const report = {
      schemaVersion: '1.0.0',
      measuredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      workspace,
      isolation: {
        postgres: `ephemeral PostgreSQL 16 on 127.0.0.1:${cluster.port}`,
        storage: 'ephemeral LocalDiskStorage under OS temp directory',
        previousFrontend:
          `git archive ${previousRelease.revision}:public ` +
          `(requested ${previousRelease.ref} from ${previousRelease.refSource}) ` +
          'served on an ephemeral loopback port',
        cleanupOnExitConfigured: true,
        externalProviderCalls: 0,
      },
      backupRestore: {
        version3: {
          backup: v3Backup,
          sourceEqualsRestore: true,
          versions: sourceSnapshot.versions,
        },
        latest: {
          backup: latestBackup,
          sourceEqualsRestore: true,
          versions: latestRestoredSnapshot.versions,
        },
      },
      migration: {
        before: sourceSnapshot.versions,
        after: latestVersions,
        files: policy.files,
        destructiveSqlFiles: policy.destructive,
        expandOnly: policy.destructive.length === 0,
      },
      deletionManifestReplay: replay,
      compatibility: {
        previousApplicationContract: oldContract,
        previousStaticFrontend: oldFrontend,
        restoredApiHealth: api,
      },
      rollback: {
        applicationContractRanAgainstLatestSchema: true,
        schemaVersionsPreserved: rollbackVersions,
        destructiveSqlRollbackAttempted: false,
        databaseRestoreUsedForApplicationRollback: false,
      },
      passed: true,
      limitations: [
        'The object-store replay used the phase-one LocalDiskStorage adapter; production S3 rehearsal requires separately authorized infrastructure.',
        `The previous frontend was archived from ${previousRelease.refSource}, resolved to ${previousRelease.revision}; no production deployment was contacted.`,
        'No real or paid provider was called.',
      ],
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ event: 'recovery_rehearsal_passed', report: reportPath }));
  } finally {
    await cluster.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'recovery_rehearsal_failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});

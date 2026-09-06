import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import { LocalDiskStorage } from '../src/infra/storage/storage.js';
import { PrecheckService } from '../src/modules/media/precheck-service.js';
import { UploadService } from '../src/modules/media/upload-service.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../src/modules/catalog/import.js';

/**
 * M04 acceptance: precheck validates template/version/single-image/settings/
 * capability; failures record stable error codes; bypassing precheck, expired
 * prechecks, and input substitution are all rejected. Uses a synthetic
 * imported catalog (B02) on the ephemeral cluster.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let prechecks: PrecheckService;
let uploads: UploadService;
let subjectId = '';
let versionId = '';
let storageRoot = '';

let PNG: Buffer = Buffer.alloc(0);

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('precheck');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'm04-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;

  PNG = await (await import('sharp')).default({
    create: { width: 2, height: 1, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'm04-storage-'));
  const storage = new LocalDiskStorage(storageRoot);
  uploads = new UploadService(client, storage);
  prechecks = new PrecheckService(client, storage);

  // Synthetic two-template catalog import (B02) so versions exist.
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'm04-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-9',
        title: '预审模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-9.txt',
        promptSha256: sha256Hex(stablePromptBody('PROMPT BODY\n')),
        source: null,
      },
    ],
  };
  const library = { schemaVersion: '1.1.0', templates: catalog.templates };
  await import('node:fs/promises').then(async (fs) => {
    await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify(library));
    await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
    await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-9.txt'), 'PROMPT BODY\n');
  });
  await importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });

  versionId = (
    await client.query<{ id: string }>("SELECT id FROM template_version WHERE template_key = 'case-9'")
  ).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

async function confirmedUpload(): Promise<string> {
  const created = await uploads.createUpload({
    ownerId: subjectId,
    declaredBytes: PNG.length,
    declaredMime: 'image/png',
  });
  if (!created.ok) {
    throw new Error('fixture upload failed');
  }
  await uploads.putQuarantineBytes(created.value.uploadId, subjectId, PNG);
  const confirm = await uploads.confirmUpload({
    uploadId: created.value.uploadId,
    ownerId: subjectId,
    actualSha256: 'placeholder',
  });
  if (!confirm.ok) {
    throw new Error('fixture confirm failed');
  }
  return confirm.value.mediaObjectId;
}

describe('precheck (M04)', () => {
  it('passes a valid precheck with capability-derived settings', async () => {
    const mediaId = await confirmedUpload();
    const result = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2', quality: 'high', aspect: 'inherit' },
    });
    expect(result.ok).toBe(true);
    const gate = await prechecks.validateForGeneration({
      precheckId: result.ok ? result.value.precheckId : '',
      subjectId,
      templateVersionId: versionId,
      inputObjectId: mediaId,
    });
    expect(gate.ok).toBe(true);
  });

  it('blocks prompt rewriting through settings with the stable error code', async () => {
    const mediaId = await confirmedUpload();
    const result = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2', prompt: 'my own words' },
    });
    expect(result).toMatchObject({ ok: false, problem: 'PROMPT_REWRITE_BLOCKED' });
  });

  it('rejects unknown templates, unknown models, and unsupported quality', async () => {
    const mediaId = await confirmedUpload();

    const unknownTemplate = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-404',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2' },
    });
    expect(unknownTemplate).toMatchObject({ ok: false, problem: 'TEMPLATE_VERSION_MISMATCH' });

    const unknownModel = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'not-a-model' },
    });
    expect(unknownModel).toMatchObject({ ok: false, problem: 'VALIDATION_FAILED' });

    const badQuality = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2', quality: 'ultra' },
    });
    expect(badQuality).toMatchObject({ ok: false, problem: 'VALIDATION_FAILED' });
  });

  it('refuses unconfirmed or foreign media', async () => {
    // Unconfirmed quarantine upload.
    const created = await uploads.createUpload({
      ownerId: subjectId,
      declaredBytes: PNG.length,
      declaredMime: 'image/png',
    });
    if (!created.ok) throw new Error('fixture failed');
    const unconfirmed = created.value.uploadId;
    const mediaId = (
      await client.query<{ media_object_id: string }>(
        'SELECT media_object_id FROM upload WHERE id = $1',
        [unconfirmed],
      )
    ).rows[0]!.media_object_id;

    const notReady = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2' },
    });
    expect(notReady).toMatchObject({ ok: false, problem: 'QUARANTINE_NOT_READY' });
  });

  it('rejects expired prechecks and input substitution at the generation gate', async () => {
    const mediaId = await confirmedUpload();
    const passed = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2' },
    });
    const precheckId = passed.ok ? passed.value.precheckId : '';

    // Expire it.
    await client.query(`UPDATE precheck SET expires_at = now() - interval '1 minute' WHERE id = $1`, [precheckId]);
    const expired = await prechecks.validateForGeneration({
      precheckId,
      subjectId,
      templateVersionId: versionId,
      inputObjectId: mediaId,
    });
    expect(expired.ok).toBe(false);

    // Fresh precheck, then attempt input substitution.
    const fresh = await prechecks.createPrecheck({
      subjectId,
      templateKey: 'case-9',
      version: 1,
      mediaObjectId: mediaId,
      settings: { model: 'gpt-image-2' },
    });
    const otherMedia = await confirmedUpload();
    const substituted = await prechecks.validateForGeneration({
      precheckId: fresh.ok ? fresh.value.precheckId : '',
      subjectId,
      templateVersionId: versionId,
      inputObjectId: otherMedia,
    });
    expect(substituted).toMatchObject({ ok: false, problem: 'VALIDATION_FAILED' });

    // Template version substitution.
    const versionSwapped = await prechecks.validateForGeneration({
      precheckId: fresh.ok ? fresh.value.precheckId : '',
      subjectId,
      templateVersionId: '00000000-0000-0000-0000-000000000009',
      inputObjectId: mediaId,
    });
    expect(versionSwapped).toMatchObject({ ok: false, problem: 'TEMPLATE_VERSION_MISMATCH' });
  });
});

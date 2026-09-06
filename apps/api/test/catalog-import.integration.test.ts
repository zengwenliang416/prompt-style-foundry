import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import {
  importCatalogRelease,
  ImportHashMismatchError,
  sha256Hex,
  stablePromptBody,
} from '../src/modules/catalog/import.js';

/**
 * B02 acceptance on the ephemeral PG harness: hash mismatch rejects, repeat
 * import is idempotent, old generations keep reading their original version,
 * and the source tree is never written.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let fixtureRoot = '';

const PROMPT_A_V1 = '[System / Prompt]\nprompt A v1\nBEGIN VISUAL BLUEPRINT\nblueprint lines\nEND VISUAL BLUEPRINT\n';
const PROMPT_B = '[System / Prompt]\nprompt B\nBEGIN VISUAL BLUEPRINT\nb blue\nEND VISUAL BLUEPRINT\n';
const PROMPT_A_V2 = '[System / Prompt]\nprompt A v2 CHANGED\nBEGIN VISUAL BLUEPRINT\nblueprint lines v2\nEND VISUAL BLUEPRINT\n';

async function writeFixture(promptA: string): Promise<void> {
  // data/library/templates.json + public/data/catalog.json + prompt files.
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 2, cases: 2, frameworks: 0 },
    filters: {},
    templates: [
      {
        id: 'case-1',
        title: '模板一',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-1.txt',
        promptSha256: sha256Hex(stablePromptBody(promptA)),
        source: null,
      },
      {
        id: 'case-2',
        title: '模板二',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'image-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-2.txt',
        promptSha256: sha256Hex(stablePromptBody(PROMPT_B)),
        source: null,
      },
    ],
  };

  const library = { schemaVersion: '1.1.0', templates: catalog.templates };
  await mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'data/prompts'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify(library));
  await writeFile(
    path.join(fixtureRoot, 'public/data/catalog.json'),
    JSON.stringify(catalog),
  );
  await writeFile(path.join(fixtureRoot, 'public/data/prompts/case-1.txt'), promptA);
  await writeFile(path.join(fixtureRoot, 'public/data/prompts/case-2.txt'), PROMPT_B);
}

async function sourceTreeDigest(): Promise<string> {
  const files = [
    'data/library/templates.json',
    'public/data/catalog.json',
    'public/data/prompts/case-1.txt',
    'public/data/prompts/case-2.txt',
  ];
  const parts: string[] = [];
  for (const file of files) {
    parts.push(`${file}:${sha256Hex(await readFile(path.join(fixtureRoot, file)))}`);
  }
  return parts.join('|');
}

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('import');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'b02-fixture-'));
  await writeFixture(PROMPT_A_V1);
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
  await cluster?.stop();
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function runImport(): Promise<ReturnType<typeof importCatalogRelease>> {
  return importCatalogRelease({ client, rootDir: fixtureRoot });
}

describe('catalog release import (B02)', () => {
  it('imports a valid fixture into release + immutable versions', async () => {
    const result = await runImport();
    expect(result.created).toBe(true);
    expect(result.templateCount).toBe(2);

    const versions = await client.query<{ template_key: string; version: number }>(
      'SELECT template_key, version FROM template_version ORDER BY template_key, version',
    );
    expect(versions.rows).toEqual([
      { template_key: 'case-1', version: 1 },
      { template_key: 'case-2', version: 1 },
    ]);
  });

  it('is idempotent for the same library (created=false, no new rows)', async () => {
    const before = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM template_version');

    const result = await runImport();

    expect(result.created).toBe(false);
    const after = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM template_version');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('rejects a tampered prompt body via hash mismatch', async () => {
    await writeFile(path.join(fixtureRoot, 'public/data/prompts/case-2.txt'), 'TAMPERED\n');

    await expect(runImport()).rejects.toThrow(ImportHashMismatchError);

    // Restore for the version-bump test.
    await writeFile(path.join(fixtureRoot, 'public/data/prompts/case-2.txt'), PROMPT_B);
  });

  it('bumps the version when content changes and old generations keep v1', async () => {
    // A generation row referencing the current (v1) case-1 version.
    const v1 = await client.query<{ id: string }>(
      "SELECT id FROM template_version WHERE template_key = 'case-1' AND version = 1",
    );
    const releaseId = (
      await client.query<{ id: string }>('SELECT id FROM catalog_release LIMIT 1')
    ).rows[0]!.id;
    const subject = await client.query<{ id: string }>(
      "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'bob', 'member') RETURNING id",
    );
    const media = await client.query<{ id: string }>(
      `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
       VALUES ($1, 'input', 'ready', 'b', 'k', 's', now() + interval '1 day') RETURNING id`,
      [subject.rows[0]!.id],
    );
    const precheck = await client.query<{ id: string }>(
      `INSERT INTO precheck (subject_id, media_object_id, template_version_id, settings, result, expires_at)
       VALUES ($1, $2, $3, '{}', 'passed', now() + interval '1 hour') RETURNING id`,
      [subject.rows[0]!.id, media.rows[0]!.id, v1.rows[0]!.id],
    );
    const generation = await client.query<{ id: string }>(
      `INSERT INTO generation (owner_id, template_version_id, catalog_release_id, precheck_id,
         input_object_id, input_sha256, compiled_prompt_sha256, effective_prompt_sha256,
         provider_id, model, settings, idempotency_key, state)
       VALUES ($1, $2, $3, $4, $5, 's', 'old', 'old', 'p', 'm', '{}', 'b02-gen', 'succeeded') RETURNING id`,
      [subject.rows[0]!.id, v1.rows[0]!.id, releaseId, precheck.rows[0]!.id, media.rows[0]!.id],
    );

    // New release with changed prompt A → new immutable version. The digest
    // baseline is taken AFTER the fixture change and BEFORE the import, so
    // any import-time write to the source tree would be caught.
    await writeFixture(PROMPT_A_V2);
    const digestBefore = await sourceTreeDigest();
    const result = await runImport();
    expect(result.created).toBe(true);

    const v2 = await client.query<{ id: string; version: number }>(
      "SELECT id, version FROM template_version WHERE template_key = 'case-1' AND compiled_prompt_sha256 = $1",
      [createHash('sha256').update(stablePromptBody(PROMPT_A_V2)).digest('hex')],
    );
    expect(v2.rows[0]!.version).toBe(2);

    // Old generation still resolves to the v1 version row (unchanged content).
    const resolved = await client.query<{ version: number }>(
      `SELECT tv.version FROM generation g JOIN template_version tv ON tv.id = g.template_version_id
       WHERE g.id = $1`,
      [generation.rows[0]!.id],
    );
    expect(resolved.rows[0]!.version).toBe(1);

    // Source tree untouched by the import (read-only discipline).
    expect(await sourceTreeDigest()).toBe(digestBefore);
  });
});

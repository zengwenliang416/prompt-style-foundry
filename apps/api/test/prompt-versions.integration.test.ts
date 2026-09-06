import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../src/modules/catalog/import.js';

/**
 * M05 acceptance: prompt changes are blocked at runtime (M04 gate) and the
 * maintenance flow — recompile (build pipeline) then reimport — creates a NEW
 * immutable version with a hash-level diff trail; nothing is silently
 * rewritten, and the source tree stays read-only.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let fixtureRoot = '';

const PROMPT_V1 = '[System / Prompt]\nv1 body\nBEGIN VISUAL BLUEPRINT\nb1\nEND VISUAL BLUEPRINT\n';
const PROMPT_V2 = '[System / Prompt]\nv2 body REWRITTEN\nBEGIN VISUAL BLUEPRINT\nb2\nEND VISUAL BLUEPRINT\n';

async function writeCatalog(promptText: string): Promise<void> {
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-77',
        title: 'M05 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-77.txt',
        promptSha256: sha256Hex(stablePromptBody(promptText)),
        source: null,
      },
    ],
  };
  const library = { schemaVersion: '1.1.0', templates: catalog.templates };
  await writeFile(path.join(fixtureRoot, 'data/library/templates.json'), JSON.stringify(library));
  await writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await writeFile(path.join(fixtureRoot, 'public/data/prompts/case-77.txt'), promptText);
}

async function sourceTreeDigest(): Promise<string> {
  return sha256Hex(
    (
      await readFile(path.join(fixtureRoot, 'public/data/prompts/case-77.txt'))
    ).toString(),
  );
}

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('m05');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'm05-fixture-'));
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await writeCatalog(PROMPT_V1);
});

afterAll(async () => {
  await client?.end();
  await rm(fixtureRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

describe('prompt version binding + maintenance flow (M05)', () => {
  it('creates v1, then a recompile+reimport creates v2 with a diff trail', async () => {
    const first = await importCatalogRelease({ client, rootDir: fixtureRoot });
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]?.version).toBe(1);
    expect(first.changes[0]?.previousCompiledPromptSha256).toBeNull();

    // Maintenance flow: edit source prompt (the compile step in the real
    // pipeline regenerates hashes), reimport — a NEW version is created.
    const digestBefore = await sourceTreeDigest();
    await writeCatalog(PROMPT_V2);
    const second = await importCatalogRelease({ client, rootDir: fixtureRoot });
    expect(second.created).toBe(true);
    expect(second.changes).toHaveLength(1);
    const change = second.changes[0]!;
    expect(change.version).toBe(2);
    expect(change.previousCompiledPromptSha256).toBe(sha256Hex(stablePromptBody(PROMPT_V1)));
    expect(change.compiledPromptSha256).toBe(sha256Hex(stablePromptBody(PROMPT_V2)));

    // Diff trail persisted in audit_event (hashes only, no prompt bodies).
    const audits = await client.query<{ action: string; detail: Record<string, unknown> }>(
      "SELECT action, detail FROM audit_event WHERE action = 'template_version_created'",
    );
    // v1 creation and the v2 rewrite both leave hash-level diff entries.
    const v2Audit = audits.rows.find(
      (row) => row.detail['compiledPromptSha256'] === sha256Hex(stablePromptBody(PROMPT_V2)),
    );
    expect(v2Audit).toBeDefined();
    expect(v2Audit!.detail).toMatchObject({
      previousCompiledPromptSha256: sha256Hex(stablePromptBody(PROMPT_V1)),
    });
    expect(JSON.stringify(audits.rows[0]!.detail)).not.toContain('REWRITTEN');

    // v1 row is immutable and still present (差异保留).
    const versions = await client.query<{ version: number; sha: string }>(
      'SELECT version, compiled_prompt_sha256 AS sha FROM template_version ORDER BY version',
    );
    expect(versions.rows).toEqual([
      { version: 1, sha: sha256Hex(stablePromptBody(PROMPT_V1)) },
      { version: 2, sha: sha256Hex(stablePromptBody(PROMPT_V2)) },
    ]);

    // Read-only discipline: the import never rewrote the source prompt.
    expect(await sourceTreeDigest()).not.toBe(digestBefore || 'never-equal-guard');
    expect(await readFile(path.join(fixtureRoot, 'public/data/prompts/case-77.txt'), 'utf8')).toBe(PROMPT_V2);
  });

  it('unchanged reimports do not create versions or audit rows', async () => {
    const before = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM template_version');
    const auditsBefore = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_event');

    await importCatalogRelease({ client, rootDir: fixtureRoot });

    expect((await client.query<{ n: string }>('SELECT count(*)::text AS n FROM template_version')).rows[0]!.n).toBe(
      before.rows[0]!.n,
    );
    expect((await client.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_event')).rows[0]!.n).toBe(
      auditsBefore.rows[0]!.n,
    );
  });
});

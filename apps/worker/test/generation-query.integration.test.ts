import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import sharp from 'sharp';

import {
  startMockProvider,
  startPgTestCluster,
  type MockProviderHandle,
  type PgTestCluster,
} from '@onepic/test-support';

import { runMigrations } from '../../api/src/db/migrate.js';
import { ProviderAdapter } from '../../api/src/modules/generation/provider-adapter.js';
import { GenerationQueryService } from '../../api/src/modules/generation/query.js';
import { verifySignedMedia } from '../../api/src/modules/media/signed-access.js';
import { LocalDiskStorage } from '../../api/src/infra/storage/storage.js';
import { validateImage } from '../../api/src/modules/media/validate-image.js';
import {
  importCatalogRelease,
  sha256Hex,
  stablePromptBody,
} from '../../api/src/modules/catalog/import.js';
import { UploadService } from '../../api/src/modules/media/upload-service.js';
import { PrecheckService } from '../../api/src/modules/media/precheck-service.js';
import { GenerationService } from '../../api/src/modules/generation/create.js';
import { claimJobs, completeJob, type Queryable } from '../src/queue.js';
import { executeClaimedJob, type ExecutionDeps } from '../src/execute.js';

/**
 * J10 acceptance: owner-only reads; prompt/input/attempt/result hashes line
 * up; expired media never rewrites the historical success; the sidecar
 * carries hashes + metadata and no secrets or prompt bodies.
 */

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SIGNING_KEY = 'j10-test-signing-key';
const PROVIDER_KEY = 'sk-j10-secret';

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let pool: Pool;
let provider: MockProviderHandle;
let storage: LocalDiskStorage;
let queries: GenerationQueryService;
let storageRoot = '';
let subjectId = '';
let otherSubjectId = '';
let precheckId = '';
let counter = 0;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('query');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  pool = new Pool({ connectionString: database.uri });
  queries = new GenerationQueryService(client, {
    signingKey: SIGNING_KEY,
    downloadTtlSeconds: 300,
  });
  provider = await startMockProvider();
  storageRoot = await mkdtemp(path.join(tmpdir(), 'j10-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  const subject = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j10-user', 'member') RETURNING id",
  );
  subjectId = subject.rows[0]!.id;
  const other = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'j10-other', 'member') RETURNING id",
  );
  otherSubjectId = other.rows[0]!.id;

  const promptBody =
    '[System / Prompt]\nj10 unique prompt body\nBEGIN VISUAL BLUEPRINT\nb\nEND VISUAL BLUEPRINT\n';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'j10-catalog-'));
  const catalog = {
    schemaVersion: '1.1.0',
    source: { project: 't', repository: 'r', archiveSha256: 'a'.repeat(64), license: 'MIT' },
    stats: { total: 1 },
    templates: [
      {
        id: 'case-101',
        title: 'J10 模板',
        kind: 'case',
        category: 'C',
        styles: [],
        scenes: [],
        tags: [],
        language: 'zh',
        mode: 'poster',
        blueprintInputMode: 'text-to-image',
        requiresText: false,
        promptPath: 'data/prompts/case-101.txt',
        promptSha256: sha256Hex(stablePromptBody(promptBody)),
        source: null,
      },
    ],
  };
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(fixtureRoot, 'data/library'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'public/data/prompts'), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, 'data/library/templates.json'),
    JSON.stringify({ schemaVersion: '1.1.0', templates: catalog.templates }),
  );
  await fs.writeFile(path.join(fixtureRoot, 'public/data/catalog.json'), JSON.stringify(catalog));
  await fs.writeFile(path.join(fixtureRoot, 'public/data/prompts/case-101.txt'), promptBody);
  await importCatalogRelease({ client, rootDir: fixtureRoot });
  await rm(fixtureRoot, { recursive: true, force: true });

  const uploads = new UploadService(client, storage);
  const prechecks = new PrecheckService(client, storage);
  const created = await uploads.createUpload({
    ownerId: subjectId,
    declaredBytes: PNG_1X1.length,
    declaredMime: 'image/png',
  });
  if (!created.ok) throw new Error('fixture failed');
  await uploads.putQuarantineBytes(created.value.uploadId, subjectId, PNG_1X1);
  const confirmed = await uploads.confirmUpload({
    uploadId: created.value.uploadId,
    ownerId: subjectId,
    actualSha256: createHash('sha256').update(PNG_1X1).digest('hex'),
  });
  if (!confirmed.ok) throw new Error('fixture failed');
  const precheck = await prechecks.createPrecheck({
    subjectId,
    templateKey: 'case-101',
    version: 1,
    mediaObjectId: confirmed.value.mediaObjectId,
    settings: { model: 'gpt-image-2', quality: 'high', aspect: 'inherit' },
  });
  if (!precheck.ok) throw new Error('fixture precheck failed');
  precheckId = precheck.value.precheckId;
});

afterAll(async () => {
  await provider?.close();
  await client?.end();
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

async function runToSuccess(): Promise<{ generationId: string; image: Buffer }> {
  counter += 1;
  const service = new GenerationService({ pool }, 5);
  const created = await service.create({
    ownerId: subjectId,
    precheckId,
    idempotencyKey: `j10-${counter}`,
    providerId: 'direct-byok',
    model: 'gpt-image-2',
  });
  if (!created.ok) throw new Error(`generation failed: ${created.code}`);
  const generationId = created.generationId;

  const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#654321' } })
    .png()
    .toBuffer();
  provider.scriptResponses([
    { status: 200, body: JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }) },
  ]);

  const deps: ExecutionDeps = {
    db: client as unknown as Queryable,
    adapter: new ProviderAdapter(
      {
        providerId: 'direct-byok',
        label: 'BYOK',
        baseUrl: provider.baseUrl,
        apiKey: PROVIDER_KEY,
        models: [{ id: 'gpt-image-2', qualities: ['high'] }],
      },
      { fetchImpl: fetch },
    ),
    storage,
    validateImage,
    providerId: 'direct-byok',
  };
  const [lease] = await claimJobs(client, { workerId: 'j10', kinds: ['generate'] });
  const outcome = await executeClaimedJob(deps, {
    jobId: lease!.jobId,
    workerId: 'j10',
    generationId,
  });
  expect(outcome.ok).toBe(true);
  await completeJob(client, {
    jobId: lease!.jobId,
    workerId: 'j10',
    generationId,
    generationState: 'succeeded',
  });
  return { generationId, image };
}

describe('generation query / download / sidecar (J10)', () => {
  it('owner reads full correspondence: prompt/input/attempt/result hashes and a working signed download', async () => {
    const { generationId, image } = await runToSuccess();
    const detail = await queries.getGeneration({ generationId, subjectId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const d = detail.value;

    expect(d.state).toBe('succeeded');
    expect(d.templateKey).toBe('case-101');
    expect(d.templateVersion).toBe(1);
    expect(d.compiledPromptSha256).toBe(d.effectivePromptSha256);
    // Sent hash == compiled hash (the provider received exactly this prompt).
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0]!.sentPromptSha256).toBe(d.compiledPromptSha256);
    expect(d.attempts[0]!.state).toBe('succeeded');
    // Input hash matches the stored input media.
    const input = (
      await client.query<{ sha256: string }>(
        `SELECT m.sha256 FROM media_object m JOIN generation g ON g.input_object_id = m.id WHERE g.id = $1`,
        [generationId],
      )
    ).rows[0]!;
    expect(d.inputSha256).toBe(input.sha256);
    // Result actuals match the decoded provider bytes.
    expect(d.result).toMatchObject({
      actualMime: 'image/png',
      actualWidth: 3,
      actualHeight: 2,
      actualBytes: image.length,
      sha256: createHash('sha256').update(image).digest('hex'),
      mediaExpired: false,
    });

    // Signed download verifies against the signing key and the owner binding.
    expect(d.downloadUrl).not.toBeNull();
    const url = new URL(d.downloadUrl!, 'http://127.0.0.1');
    const parts = url.pathname.split('/');
    const verified = verifySignedMedia(
      {
        bucket: parts[4]!,
        key: parts.slice(5).join('/'),
        ownerId: url.searchParams.get('owner') ?? '',
        expires: url.searchParams.get('expires') ?? undefined,
        signature: url.searchParams.get('signature') ?? undefined,
        method: 'GET',
      },
      SIGNING_KEY,
    );
    expect(verified.ok).toBe(true);
    // A foreign subject presenting the same link fails the owner binding check.
    expect(url.searchParams.get('owner')).toBe(subjectId);
  });

  it('denies cross-user and missing reads', async () => {
    const { generationId } = await runToSuccess();
    await expect(
      queries.getGeneration({ generationId, subjectId: otherSubjectId }),
    ).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    await expect(
      queries.getGeneration({ generationId: '00000000-0000-0000-0000-0000000000ff', subjectId }),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    await expect(queries.getSidecar({ generationId, subjectId: otherSubjectId })).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('expired media keeps the historical success but withdraws the download', async () => {
    const { generationId, image } = await runToSuccess();
    // Simulate the cleanup flow: media expired, generation succeeded → expired.
    await client.query(
      `UPDATE media_object SET state = 'expired', expires_at = now() - interval '1 hour'
       WHERE id = (SELECT media_object_id FROM result WHERE generation_id = $1)`,
      [generationId],
    );
    await client.query(
      `UPDATE generation SET state = 'expired', updated_at = now() WHERE id = $1 AND state = 'succeeded'`,
      [generationId],
    );

    const detail = await queries.getGeneration({ generationId, subjectId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    // History intact: terminal state + attempt facts + hashes survive expiry.
    expect(detail.value.state).toBe('expired');
    expect(detail.value.attempts[0]!.state).toBe('succeeded');
    expect(detail.value.result).toMatchObject({
      sha256: createHash('sha256').update(image).digest('hex'),
      mediaState: 'expired',
      mediaExpired: true,
      actualWidth: 3,
      actualHeight: 2,
    });
    expect(detail.value.downloadUrl).toBeNull();
  });

  it('sidecar carries hashes and metadata only — no keys, no prompt body', async () => {
    const { generationId, image } = await runToSuccess();
    const sidecar = await queries.getSidecar({ generationId, subjectId });
    expect(sidecar.ok).toBe(true);
    if (!sidecar.ok) return;
    const s = sidecar.value;

    expect(s.kind).toBe('onepic-generation-sidecar');
    expect(s.template).toEqual({ key: 'case-101', version: 1 });
    expect(s.prompt.compiledSha256).toBe(s.prompt.effectiveSha256);
    expect(s.attempts[0]!.sentPromptSha256).toBe(s.prompt.compiledSha256);
    expect(s.result).toMatchObject({
      sha256: createHash('sha256').update(image).digest('hex'),
      mime: 'image/png',
      width: 3,
      height: 2,
    });

    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain(PROVIDER_KEY);
    expect(serialized).not.toContain(SIGNING_KEY);
    expect(serialized).not.toContain('j10 unique prompt body');
    expect(serialized).not.toContain('sk-');
  });
});

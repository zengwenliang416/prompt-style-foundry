import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import { LocalDiskStorage } from '../src/infra/storage/storage.js';
import { UploadService } from '../src/modules/media/upload-service.js';

/**
 * M01 acceptance: owner checks, expiry, double confirmation, incomplete
 * uploads, and forged object paths are all rejected; unconfirmed quarantine
 * objects are not marked ready.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let service: UploadService;
let ownerA = '';
let ownerB = '';

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('media');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();
  service = new UploadService(
    client,
    new LocalDiskStorage('/tmp/onepic-m01-storage'),
  );

  const a = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'm01-a', 'member') RETURNING id",
  );
  ownerA = a.rows[0]!.id;
  const b = await client.query<{ id: string }>(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'm01-b', 'member') RETURNING id",
  );
  ownerB = b.rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
  await cluster?.stop();
});

describe('upload sessions with quarantine (M01)', () => {
  it('rejects unsupported MIME and oversized declarations at creation', async () => {
    const badMime = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: 10,
      declaredMime: 'image/gif',
    });
    expect(badMime).toMatchObject({ ok: false, problem: 'UNSUPPORTED_MEDIA_TYPE' });

    const tooBig = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: 21 * 1024 * 1024,
      declaredMime: 'image/png',
    });
    expect(tooBig).toMatchObject({ ok: false, problem: 'PAYLOAD_TOO_LARGE' });
  });

  it('creates a quarantine session with a server-generated key and confirms a full upload', async () => {
    const created = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: PNG_BYTES.length,
      declaredMime: 'image/png',
    });
    if (!created.ok) {
      throw new Error('unexpected creation failure');
    }
    // Server-generated key: opaque UUID path, never client-chosen.
    expect(created.value.objectKey).toContain(ownerA);
    expect(created.value.objectKey).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/);

    const put = await service.putQuarantineBytes(created.value.uploadId, ownerA, PNG_BYTES);
    expect(put.ok).toBe(true);

    const confirm = await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerA,
      actualSha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
    });
    expect(confirm.ok).toBe(true);

    // Confirmed object leaves quarantine only via M02 validation; state stays
    // quarantine here but is confirmed and owned.
    const media = await client.query<{ state: string; sha256: string }>(
      'SELECT state, sha256 FROM media_object WHERE id = $1',
      [confirm.ok ? confirm.value.mediaObjectId : ''],
    );
    expect(media.rows[0]!.state).toBe('quarantine');
    expect(media.rows[0]!.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'));
  });

  it('rejects double confirmation', async () => {
    const created = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: PNG_BYTES.length,
      declaredMime: 'image/png',
    });
    if (!created.ok) throw new Error('unexpected');
    await service.putQuarantineBytes(created.value.uploadId, ownerA, PNG_BYTES);
    await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerA,
      actualSha256: 'sha',
    });

    const second = await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerA,
      actualSha256: 'sha',
    });
    expect(second).toMatchObject({ ok: false, problem: 'ALREADY_CONFIRMED' });
  });

  it('rejects incomplete uploads (no bytes or short bytes)', async () => {
    const created = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: 100,
      declaredMime: 'image/png',
    });
    if (!created.ok) throw new Error('unexpected');

    const confirmWithoutBytes = await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerA,
      actualSha256: 'sha',
    });
    expect(confirmWithoutBytes).toMatchObject({ ok: false, problem: 'INCOMPLETE_UPLOAD' });

    await service.putQuarantineBytes(created.value.uploadId, ownerA, Buffer.alloc(50));
    const confirmShort = await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerA,
      actualSha256: 'sha',
    });
    expect(confirmShort).toMatchObject({ ok: false, problem: 'INCOMPLETE_UPLOAD' });
  });

  it('rejects a foreign owner confirming someone else’s upload', async () => {
    const created = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: PNG_BYTES.length,
      declaredMime: 'image/png',
    });
    if (!created.ok) throw new Error('unexpected');

    const foreignPut = await service.putQuarantineBytes(created.value.uploadId, ownerB, PNG_BYTES);
    expect(foreignPut).toMatchObject({ ok: false, problem: 'FORBIDDEN' });

    const foreignConfirm = await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerB,
      actualSha256: 'sha',
    });
    expect(foreignConfirm).toMatchObject({ ok: false, problem: 'FORBIDDEN' });
  });

  it('rejects expired sessions at confirm time', async () => {
    const created = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: PNG_BYTES.length,
      declaredMime: 'image/png',
    });
    if (!created.ok) throw new Error('unexpected');
    await service.putQuarantineBytes(created.value.uploadId, ownerA, PNG_BYTES);

    await client.query(
      `UPDATE media_object SET expires_at = now() - interval '1 minute'
       WHERE id = (SELECT media_object_id FROM upload WHERE id = $1)`,
      [created.value.uploadId],
    );

    const confirm = await service.confirmUpload({
      uploadId: created.value.uploadId,
      ownerId: ownerA,
      actualSha256: 'sha',
    });
    expect(confirm).toMatchObject({ ok: false, problem: 'UPLOAD_EXPIRED' });
  });

  it('never marks unconfirmed quarantine objects ready', async () => {
    const created = await service.createUpload({
      ownerId: ownerA,
      declaredBytes: PNG_BYTES.length,
      declaredMime: 'image/png',
    });
    if (!created.ok) throw new Error('unexpected');

    const state = await client.query<{ state: string; unconfirmed: boolean }>(
      `SELECT m.state, (u.confirmed_at IS NULL) AS unconfirmed
       FROM media_object m JOIN upload u ON u.media_object_id = m.id
       WHERE u.id = $1`,
      [created.value.uploadId],
    );
    expect(state.rows[0]!.state).toBe('quarantine');
    expect(state.rows[0]!.unconfirmed).toBe(true);
  });

  it('refuses forged object paths in the storage adapter', async () => {
    const storage = new LocalDiskStorage('/tmp/onepic-m01-forged');
    await expect(
      storage.put({ bucket: 'quarantine', key: '../escape', body: Buffer.alloc(1) }),
    ).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(
      storage.put({ bucket: '../evil', key: 'x', body: Buffer.alloc(1) }),
    ).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(
      storage.get({ bucket: 'quarantine', key: 'a/../../etc/passwd' }),
    ).rejects.toThrow('FORGED_OBJECT_PATH');
  });
});

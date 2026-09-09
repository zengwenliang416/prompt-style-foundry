import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { buildApp } from '../src/bootstrap/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { LocalDiskStorage } from '../src/infra/storage/storage.js';
import { signMediaPath } from '../src/modules/media/signed-access.js';
import type { ApiConfig } from '../src/config/env.js';

/**
 * M03 acceptance: private storage is signed, short-lived, owner-bound, and
 * cache-private; cross-user access fails; the local adapter reads and writes
 * real bytes on this machine.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let app: Awaited<ReturnType<typeof buildApp>>;
let storage: LocalDiskStorage;
let storageRoot = '';
let ownerB = '';
let ownerA = '';
let sessionB = '';
let sessionA = '';

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
  'hex',
);
const SESSION_SECRET = 'test-only-session-secret-'.repeat(2);

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('media_access');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  storageRoot = await mkdtemp(path.join(tmpdir(), 'm03-storage-'));
  storage = new LocalDiskStorage(storageRoot);

  await client.query(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'm03-b', 'member')",
  );
  await client.query(
    "INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', 'm03-a', 'member')",
  );
  ownerB = (
    await client.query<{ id: string }>("SELECT id FROM subject WHERE subject_claim='m03-b'")
  ).rows[0]!.id;
  ownerA = (
    await client.query<{ id: string }>("SELECT id FROM subject WHERE subject_claim='m03-a'")
  ).rows[0]!.id;

  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    runMode: 'managed-generation',
    databaseUrl: database.uri,
    oidcIssuer: 'https://id.test',
    oidcClientId: 'onepic-api',
    oidcClientSecret: 'b03-test-secret',
    oidcRedirectUri: 'http://127.0.0.1:9999/api/v1/auth/callback',
    sessionSecret: SESSION_SECRET,
    mediaStorageRoot: storageRoot,
  };
  app = buildApp(config);

  // Sessions for both subjects (opaque tokens via the repository).
  const { PgSessionRepository } = await import('../src/modules/identity/pg-session-repository.js');
  const repo = new PgSessionRepository(client);
  const sessionForB = await repo.create({ subjectId: ownerB, ttlSeconds: 3600 });
  const sessionForA = await repo.create({ subjectId: ownerA, ttlSeconds: 3600 });
  sessionB = sessionForB.token;
  sessionA = sessionForA.token;
});

afterAll(async () => {
  await app?.close();
  await client?.end();
  await rm(storageRoot, { recursive: true, force: true });
  await database?.drop();
  await cluster?.stop();
});

describe('signed private media access (M03)', () => {
  /** O01: the media route now re-checks media_object state — tests register their objects. */
  async function registerObject(bucket: string, key: string, ownerId: string): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, mime, expires_at)
       VALUES ($1, 'input', 'ready', $2, $3, $4, 'image/png', now() + interval '1 hour')
       RETURNING id`,
      [ownerId, bucket, key, 'a'.repeat(64)],
    );
    return inserted.rows[0]!.id;
  }

  it('round-trips bytes through the local private storage adapter', async () => {
    await storage.put({ bucket: 'quarantine', key: 'roundtrip/x.png', body: PNG_BYTES });
    const read = await storage.get({ bucket: 'quarantine', key: 'roundtrip/x.png' });
    expect(read.equals(PNG_BYTES)).toBe(true);
  });

  it('serves the owner their media with a private cache policy', async () => {
    await storage.put({ bucket: 'quarantine', key: 'owner/x.png', body: PNG_BYTES });
    await registerObject('quarantine', 'owner/x.png', ownerB);
    const signed = signMediaPath(
      { bucket: 'quarantine', key: 'owner/x.png', ownerId: ownerB, method: 'GET', ttlSeconds: 300 },
      SESSION_SECRET,
    );

    const response = await app.inject({
      method: 'GET',
      url: signed.path,
      cookies: { onepic_session: sessionB },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload?.equals(PNG_BYTES)).toBe(true);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-type']).toBe('image/png');
  });

  it('revokes a still-valid signed URL once the object expires or is deleted (O01)', async () => {
    await storage.put({ bucket: 'quarantine', key: 'owner/revoked.png', body: PNG_BYTES });
    const objectId = await registerObject('quarantine', 'owner/revoked.png', ownerB);
    const signed = signMediaPath(
      {
        bucket: 'quarantine',
        key: 'owner/revoked.png',
        ownerId: ownerB,
        method: 'GET',
        ttlSeconds: 300,
      },
      SESSION_SECRET,
    );

    const live = await app.inject({
      method: 'GET',
      url: signed.path,
      cookies: { onepic_session: sessionB },
    });
    expect(live.statusCode).toBe(200);

    await client.query(`UPDATE media_object SET state = 'expired' WHERE id = $1`, [objectId]);
    const expired = await app.inject({
      method: 'GET',
      url: signed.path,
      cookies: { onepic_session: sessionB },
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: { code: 'MEDIA_EXPIRED' } });

    await client.query(`UPDATE media_object SET state = 'deleted' WHERE id = $1`, [objectId]);
    const deleted = await app.inject({
      method: 'GET',
      url: signed.path,
      cookies: { onepic_session: sessionB },
    });
    expect(deleted.statusCode).toBe(410);

    // A signature for an object with no database row at all is a 404.
    const unknown = signMediaPath(
      {
        bucket: 'quarantine',
        key: 'owner/never-existed.png',
        ownerId: ownerB,
        method: 'GET',
        ttlSeconds: 300,
      },
      SESSION_SECRET,
    );
    const missing = await app.inject({
      method: 'GET',
      url: unknown.path,
      cookies: { onepic_session: sessionB },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('fails cross-user access even with a valid signature for the owner', async () => {
    await storage.put({ bucket: 'quarantine', key: 'owner/x.png', body: PNG_BYTES });
    const signedForB = signMediaPath(
      { bucket: 'quarantine', key: 'owner/x.png', ownerId: ownerB, method: 'GET', ttlSeconds: 300 },
      SESSION_SECRET,
    );

    // A presents B's link: the session owner does not match the signed owner.
    const asA = await app.inject({
      method: 'GET',
      url: signedForB.path,
      cookies: { onepic_session: sessionA },
    });
    expect(asA.statusCode).toBe(404);
    expect(asA.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    // No session at all: also denied.
    const anonymous = await app.inject({ method: 'GET', url: signedForB.path });
    expect(anonymous.statusCode).toBe(404);
  });

  it('expires signed links and rejects tampered signatures', async () => {
    await storage.put({ bucket: 'quarantine', key: 'owner/exp.png', body: PNG_BYTES });

    const expired = signMediaPath(
      {
        bucket: 'quarantine',
        key: 'owner/exp.png',
        ownerId: ownerB,
        method: 'GET',
        ttlSeconds: -10,
      },
      SESSION_SECRET,
    );
    const expiredResponse = await app.inject({
      method: 'GET',
      url: expired.path,
      cookies: { onepic_session: sessionB },
    });
    expect(expiredResponse.statusCode).toBe(410);
    expect(expiredResponse.json()).toMatchObject({ error: { code: 'MEDIA_EXPIRED' } });

    const tampered = signMediaPath(
      {
        bucket: 'quarantine',
        key: 'owner/exp.png',
        ownerId: ownerB,
        method: 'GET',
        ttlSeconds: 300,
      },
      SESSION_SECRET,
    ).path.replace('signature=', 'signature=AAAA');
    const tamperedResponse = await app.inject({
      method: 'GET',
      url: tampered,
      cookies: { onepic_session: sessionB },
    });
    expect(tamperedResponse.statusCode).toBe(403);
  });
});

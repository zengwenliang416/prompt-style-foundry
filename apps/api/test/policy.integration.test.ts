import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

import { runMigrations } from '../src/db/migrate.js';
import type { Subject } from '../src/modules/identity/port.js';
import { decideObjectAccess } from '../src/modules/policy/access.js';

/**
 * B04 acceptance: object-level isolation between users and the admin media
 * boundary, enforced end-to-end from the decision function through SQL
 * owner-scoped queries on the real schema.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;
let client: Client;
let userA: Subject;
let userB: Subject;
let admin: Subject;
let bMediaId = '';
let bCollectionId = '';

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('policy');
  await runMigrations(database.uri);
  client = new Client({ connectionString: database.uri });
  await client.connect();

  const insert = async (claim: string, role: 'member' | 'admin'): Promise<Subject> => {
    const row = await client.query<{
      id: string;
      issuer: string;
      subject_claim: string;
      role: 'member' | 'admin';
    }>(
      `INSERT INTO subject (issuer, subject_claim, role) VALUES ('https://id.test', $1, $2) RETURNING id, issuer, subject_claim, role`,
      [claim, role],
    );
    const r = row.rows[0]!;
    return { id: r.id, issuer: r.issuer, subjectClaim: r.subject_claim, role: r.role };
  };

  userA = await insert('user-a', 'member');
  userB = await insert('user-b', 'member');
  admin = await insert('admin-1', 'admin');

  // B owns an input media object and a collection.
  const media = await client.query<{ id: string }>(
    `INSERT INTO media_object (owner_id, kind, state, bucket, object_key, sha256, expires_at)
     VALUES ($1, 'input', 'ready', 'bucket', 'b-key', 'sha-b', now() + interval '1 day') RETURNING id`,
    [userB.id],
  );
  bMediaId = media.rows[0]!.id;
  const collection = await client.query<{ id: string }>(
    `INSERT INTO collection (owner_id, name) VALUES ($1, 'b-collections') RETURNING id`,
    [userB.id],
  );
  bCollectionId = collection.rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
  await cluster?.stop();
});

async function mediaCountFor(actor: Subject | null): Promise<string> {
  // Owner-scoped query shape: actor's id is always a filter parameter.
  const ownerId = actor === null ? '00000000-0000-0000-0000-000000000000' : actor.id;
  const result = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM media_object WHERE id = $1 AND owner_id = $2',
    [bMediaId, ownerId],
  );
  return result.rows[0]!.n;
}

describe('object-level authorization (B04)', () => {
  it('denies unauthenticated actors entirely', () => {
    expect(decideObjectAccess(null, userB.id, 'read-metadata')).toEqual({
      allowed: false,
      code: 'UNAUTHENTICATED',
      foreign: false,
    });
  });

  it('lets a member read and write only their own objects', () => {
    expect(decideObjectAccess(userB, userB.id, 'read-metadata')).toEqual({ allowed: true });
    expect(decideObjectAccess(userB, userB.id, 'read-media')).toEqual({ allowed: true });
    expect(decideObjectAccess(userB, userB.id, 'write')).toEqual({ allowed: true });
  });

  it('denies user A every action on user B objects (foreign → 404 mapping)', () => {
    for (const action of ['read-metadata', 'read-media', 'write'] as const) {
      const decision = decideObjectAccess(userA, userB.id, action);
      expect(decision).toEqual({ allowed: false, code: 'FORBIDDEN', foreign: true });
    }
  });

  it('allows admin metadata inspection but denies admin media reads and writes', () => {
    expect(decideObjectAccess(admin, userB.id, 'read-metadata')).toEqual({ allowed: true });
    expect(decideObjectAccess(admin, userB.id, 'read-media')).toEqual({
      allowed: false,
      code: 'FORBIDDEN',
      foreign: true,
    });
    expect(decideObjectAccess(admin, userB.id, 'write')).toEqual({
      allowed: false,
      code: 'FORBIDDEN',
      foreign: true,
    });
  });

  it('enforces ownership at the SQL layer: user A queries see none of B media', async () => {
    await expect(mediaCountFor(userA)).resolves.toBe('0');
    await expect(mediaCountFor(userB)).resolves.toBe('1');
    await expect(mediaCountFor(admin)).resolves.toBe('0');
    await expect(mediaCountFor(null)).resolves.toBe('0');
  });

  it('enforces collection ownership at the SQL layer', async () => {
    const asA = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection WHERE id = $1 AND owner_id = $2',
      [bCollectionId, userA.id],
    );
    expect(asA.rows[0]!.n).toBe('0');
    const asB = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection WHERE id = $1 AND owner_id = $2',
      [bCollectionId, userB.id],
    );
    expect(asB.rows[0]!.n).toBe('1');
  });

  it('denies collection writes across owners', () => {
    expect(decideObjectAccess(userA, userB.id, 'write')).toEqual({
      allowed: false,
      code: 'FORBIDDEN',
      foreign: true,
    });
  });
});

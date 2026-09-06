import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { startPgTestCluster, type PgTestCluster } from '@onepic/test-support';

/**
 * Facility validation for the F04 integration harness: boots an ephemeral
 * PostgreSQL 16 cluster, creates an isolated database, exercises SQL, and
 * tears everything down. B01 migrations and later repository tests will run
 * on this harness. No remote host is contacted; trust auth is loopback-only.
 */

let cluster: PgTestCluster;
let database: Awaited<ReturnType<PgTestCluster['createDatabase']>>;

beforeAll(async () => {
  cluster = await startPgTestCluster();
  database = await cluster.createDatabase('facility');
});

afterAll(async () => {
  await database?.drop();
  await cluster?.stop();
});

describe('ephemeral PostgreSQL integration facility', () => {
  it('provides a real PostgreSQL 16 server on loopback', async () => {
    const client = new Client({ connectionString: database.uri });
    await client.connect();
    try {
      const version = await client.query<{ version: string }>('SELECT version()');
      expect(version.rows[0]?.version).toContain('PostgreSQL 16');
    } finally {
      await client.end();
    }
  });

  it('runs transactions with isolated, disposable schemas', async () => {
    const client = new Client({ connectionString: database.uri });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE facility_check (id integer primary key, label text)');
      await client.query("INSERT INTO facility_check (id, label) VALUES (1, 'onepic')");
      const inserted = await client.query<{ label: string }>(
        'SELECT label FROM facility_check WHERE id = 1',
      );
      expect(inserted.rows[0]?.label).toBe('onepic');
      await client.query('ROLLBACK');
      const afterRollback = await client.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'facility_check'",
      );
      expect(afterRollback.rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('creates per-test databases that do not collide across runs', async () => {
    const other = await cluster.createDatabase('other');
    try {
      expect(other.name).not.toBe(database.name);
      const client = new Client({ connectionString: other.uri });
      await client.connect();
      const probe = await client.query('SELECT current_database() AS db');
      expect(probe.rows[0]?.db).toBe(other.name);
      await client.end();
    } finally {
      await other.drop();
    }
  });
});

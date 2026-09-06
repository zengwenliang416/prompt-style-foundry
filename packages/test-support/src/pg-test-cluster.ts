import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Ephemeral PostgreSQL cluster for integration tests (checklist F04).
 *
 * Runs a real PostgreSQL 16 (Homebrew install or ONEPIC_PG_BIN override)
 * fully inside a temp data directory on a loopback-only, random port with
 * trust auth. Every run creates and destroys its own cluster: tests are
 * independently re-runnable, isolated from each other and from any
 * production/staging instance, and never touch remote hosts.
 */

export interface PgTestDatabase {
  name: string;
  uri: string;
  drop(): Promise<void>;
}

export interface PgTestCluster {
  port: number;
  /** Superuser URI for bootstrapping; prefer per-test databases. */
  superuserUri: string;
  createDatabase(label?: string): Promise<PgTestDatabase>;
  stop(): Promise<void>;
}

function resolvePgBin(): string {
  const binDir = process.env['ONEPIC_PG_BIN'] ?? '/opt/homebrew/opt/postgresql@16/bin';
  if (binDir.trim() === '') {
    throw new Error('ONEPIC_PG_BIN is empty; set it to a PostgreSQL >=16 bin directory.');
  }
  return binDir;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('failed to acquire a free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(binDir: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await exec(path.join(binDir, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port)], {
        timeout: 5_000,
      });
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error('PostgreSQL test cluster did not become ready', { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function psql(binDir: string, port: number, sql: string): Promise<string> {
  const result = await exec(
    path.join(binDir, 'psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { timeout: 30_000 },
  );
  return result.stdout;
}

export async function startPgTestCluster(options?: { binDir?: string }): Promise<PgTestCluster> {
  const binDir = options?.binDir ?? resolvePgBin();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'onepic-pgtest-'));
  const port = await findFreePort();

  try {
    // Pin lc_messages=C so server error text is locale-independent and tests
    // can match it regardless of the developer machine's LANG/LC_ALL.
    await exec(path.join(binDir, 'initdb'), ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--lc-messages=C'], {
      timeout: 120_000,
    });
    await exec(
      path.join(binDir, 'pg_ctl'),
      [
        '-D',
        dataDir,
        '-o',
        `-p ${port} -c listen_addresses=127.0.0.1 -k ${dataDir}`,
        '-l',
        path.join(dataDir, 'pg.log'),
        'start',
      ],
      { timeout: 60_000 },
    );
    await waitUntilReady(binDir, port, 30_000);
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error instanceof Error ? error : new Error(String(error));
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      await exec(path.join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], {
        timeout: 60_000,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  const createDatabase = async (label?: string): Promise<PgTestDatabase> => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const name = `onepic_test_${label ?? 'db'}_${suffix}`.slice(0, 63);
    await psql(binDir, port, `CREATE DATABASE ${name}`);
    return {
      name,
      uri: `postgresql://postgres@127.0.0.1:${port}/${name}`,
      drop: async () => {
        await psql(binDir, port, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      },
    };
  };

  return {
    port,
    superuserUri: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    createDatabase,
    stop,
  };
}

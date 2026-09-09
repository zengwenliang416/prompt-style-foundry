import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalDiskStorage } from './storage.js';

/**
 * O03 path-traversal negative cases: object keys are server-generated, and
 * the storage adapter itself refuses forged paths (defense in depth — even a
 * compromised caller of the port cannot escape the storage root).
 */

let root = '';
let storage: LocalDiskStorage;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'storage-neg-'));
  storage = new LocalDiskStorage(root);
  // A decoy file OUTSIDE the storage root that traversal must never reach.
  await writeFile(path.join(root, '..', 'escape-canary.txt'), 'canary');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(path.join(root, '..', 'escape-canary.txt'), { force: true });
});

describe('LocalDiskStorage forged-path rejection (O03)', () => {
  it.each([
    { bucket: 'private', key: '../escape-canary.txt' },
    { bucket: 'private', key: 'a/../../escape-canary.txt' },
    { bucket: 'private', key: '/etc/passwd' },
  ])('rejects %o on every operation', async (forged) => {
    await expect(storage.get(forged)).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(storage.size(forged)).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(storage.remove(forged)).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(storage.put({ ...forged, body: Buffer.from('x') })).rejects.toThrow(
      'FORGED_OBJECT_PATH',
    );
  });

  it('rejects forged bucket names', async () => {
    await expect(storage.get({ bucket: '..', key: 'escape-canary.txt' })).rejects.toThrow(
      'FORGED_OBJECT_PATH',
    );
    await expect(storage.get({ bucket: 'private/../../etc', key: 'passwd' })).rejects.toThrow(
      'FORGED_OBJECT_PATH',
    );
  });
});

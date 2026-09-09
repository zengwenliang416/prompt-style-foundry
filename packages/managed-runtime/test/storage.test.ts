import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalDiskStorage } from '../src/storage.js';

const roots: string[] = [];

async function createStorage(): Promise<LocalDiskStorage> {
  const root = await mkdtemp(path.join(tmpdir(), 'onepic-managed-runtime-'));
  roots.push(root);
  return new LocalDiskStorage(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalDiskStorage shared runtime contract', () => {
  it('round-trips objects through the storage port', async () => {
    const storage = await createStorage();
    const object = { bucket: 'private', key: 'results/job-1.png' };

    await storage.put({ ...object, body: Buffer.from('image-bytes') });
    await expect(storage.get(object)).resolves.toEqual(Buffer.from('image-bytes'));
    await expect(storage.size(object)).resolves.toBe(11);
    await storage.remove(object);
    await expect(storage.get(object)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { bucket: 'private', key: '../escape' },
    { bucket: 'private', key: 'a/../../escape' },
    { bucket: 'private', key: '/etc/passwd' },
    { bucket: '..', key: 'escape' },
    { bucket: 'private/../../etc', key: 'passwd' },
  ])('rejects forged object paths on every operation: %o', async (object) => {
    const storage = await createStorage();

    await expect(storage.get(object)).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(storage.size(object)).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(storage.remove(object)).rejects.toThrow('FORGED_OBJECT_PATH');
    await expect(storage.put({ ...object, body: Buffer.from('x') })).rejects.toThrow(
      'FORGED_OBJECT_PATH',
    );
  });
});

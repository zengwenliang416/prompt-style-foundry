import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { MediaRemover } from './cleanup.js';

/**
 * Local-disk media remover for the retention sweep (O01). Same path-safety
 * rules as the API's LocalDiskStorage (server-generated keys only); the
 * production deployment swaps in an S3-compatible private implementation.
 */
export class LocalDiskRemover implements MediaRemover {
  constructor(private readonly rootDir: string) {}

  async remove(input: { bucket: string; key: string }): Promise<void> {
    if (
      !/^[a-z0-9_-]+$/.test(input.bucket) ||
      input.key.includes('..') ||
      input.key.startsWith('/')
    ) {
      throw new Error('FORGED_OBJECT_PATH');
    }
    await rm(path.resolve(this.rootDir, input.bucket, input.key), { force: true });
  }
}

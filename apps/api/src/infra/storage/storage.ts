import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Private object storage port (M01/M03). Objects are addressed by
 * server-generated keys only; the port never accepts client-supplied paths.
 * LocalDiskStorage is the test/local adapter; production swaps in an
 * S3-compatible private implementation behind the same interface (ADR 0001).
 */
export interface StoragePort {
  put(input: { bucket: string; key: string; body: Buffer }): Promise<void>;
  get(input: { bucket: string; key: string }): Promise<Buffer>;
  size(input: { bucket: string; key: string }): Promise<number>;
  remove(input: { bucket: string; key: string }): Promise<void>;
}

export class LocalDiskStorage implements StoragePort {
  constructor(private readonly rootDir: string) {}

  private resolve(bucket: string, key: string): string {
    if (!/^[a-z0-9_-]+$/.test(bucket) || key.includes('..') || key.startsWith('/')) {
      throw new Error('FORGED_OBJECT_PATH');
    }
    return path.resolve(this.rootDir, bucket, key);
  }

  async put(input: { bucket: string; key: string; body: Buffer }): Promise<void> {
    const file = this.resolve(input.bucket, input.key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, input.body);
  }

  async get(input: { bucket: string; key: string }): Promise<Buffer> {
    return readFile(this.resolve(input.bucket, input.key));
  }

  async size(input: { bucket: string; key: string }): Promise<number> {
    const file = this.resolve(input.bucket, input.key);
    const info = await stat(file);
    return info.size;
  }

  async remove(input: { bucket: string; key: string }): Promise<void> {
    await rm(this.resolve(input.bucket, input.key), { force: true });
  }
}

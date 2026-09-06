import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { sha256Hex, stablePromptBody, verifyPromptHash } from './hash.js';

describe('prompt hash integrity (U05)', () => {
  it('strips trailing newlines like the build stable_digest', () => {
    expect(stablePromptBody('body\n\n')).toBe('body');
    expect(stablePromptBody('body')).toBe('body');
  });

  it('hashes text with WebCrypto equivalently to node:crypto', async () => {
    const text = '[System / Prompt] 试例正文';
    const expected = createHash('sha256').update(text).digest('hex');
    await expect(sha256Hex(text)).resolves.toBe(expected);
  });

  it('verifies the real shipped prompt against the catalog hash (case-1)', async () => {
    const catalog = JSON.parse(readFileSync(path.resolve('public/data/catalog.json'), 'utf8')) as {
      templates: Array<{ id: string; promptSha256: string }>;
    };
    const entry = catalog.templates.find((template) => template.id === 'case-1');
    expect(entry).toBeDefined();

    const text = readFileSync(path.resolve('public/data/prompts/case-1.txt'), 'utf8');
    await expect(verifyPromptHash(text, entry!.promptSha256)).resolves.toBe(true);
  });

  it('rejects a tampered body', async () => {
    await expect(
      verifyPromptHash(
        'tampered',
        '7d62e941807e27279922caf24977ed4bcefe72ad901069706e9540654d162dc1',
      ),
    ).resolves.toBe(false);
  });
});

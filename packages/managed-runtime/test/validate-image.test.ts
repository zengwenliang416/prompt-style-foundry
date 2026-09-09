import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { validateImage } from '../src/validate-image.js';

async function pngOf(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c86432' } })
    .png()
    .toBuffer();
}

describe('validateImage shared runtime contract', () => {
  it('accepts a decoded PNG and reports measured metadata', async () => {
    const png = await pngOf(32, 20);
    const outcome = await validateImage(png, { declaredMime: 'image/png' });

    expect(outcome).toEqual({
      ok: true,
      value: {
        mime: 'image/png',
        bytes: png.length,
        width: 32,
        height: 20,
        orientation: 1,
      },
    });
  });

  it('rejects MIME lies and non-raster text payloads', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000000' },
    })
      .jpeg()
      .toBuffer();
    await expect(validateImage(jpeg, { declaredMime: 'image/png' })).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
    await expect(
      validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        declaredMime: 'image/png',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('enforces byte and decoded-pixel ceilings', async () => {
    const png = await pngOf(120, 120);
    await expect(validateImage(png, { maxBytes: png.length - 1 })).resolves.toMatchObject({
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
    });
    await expect(validateImage(png, { maxPixels: 10_000 })).resolves.toMatchObject({
      ok: false,
      code: 'PIXEL_LIMIT_EXCEEDED',
    });
  });

  it('rejects truncated images after a real decode attempt', async () => {
    const png = await pngOf(32, 32);
    await expect(validateImage(png.subarray(0, 40))).resolves.toMatchObject({
      ok: false,
      code: 'MALFORMED_IMAGE',
    });
  });

  it('preserves EXIF orientation metadata', async () => {
    const oriented = await sharp(await pngOf(12, 8))
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const outcome = await validateImage(oriented);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.orientation).toBe(6);
    }
  });
});

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { validateImage } from '../src/modules/media/validate-image.js';

/**
 * M02 acceptance: magic/MIME consistency, real decode (dimension lies and
 * decompression bombs), byte/pixel ceilings, animation and SVG rejection.
 * All fixtures are synthesized in-process — no external files, no egress.
 */

async function pngOf(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .png()
    .toBuffer();
}

describe('validateImage (M02)', () => {
  it('accepts a real PNG and reports measured values', async () => {
    const png = await pngOf(320, 200);
    const result = await validateImage(png, { declaredMime: 'image/png' });
    expect(result).toEqual({
      ok: true,
      value: {
        mime: 'image/png',
        bytes: png.length,
        width: 320,
        height: 200,
        orientation: 1,
      },
    });
  });

  it('accepts a real JPEG', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer();
    const result = await validateImage(jpeg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mime).toBe('image/jpeg');
      expect(result.value.width).toBe(64);
    }
  });

  it('rejects a fake suffix: GIF bytes claiming to be PNG', async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .gif()
      .toBuffer();
    const result = await validateImage(gif, { declaredMime: 'image/png' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // GIF magic is not in the accepted list at all.
      expect(result.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('rejects SVG and text payloads regardless of extension claims', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
    );
    const result = await validateImage(svg, { declaredMime: 'image/png' });
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('rejects header lies: declared dimensions beyond the pixel ceiling', async () => {
    // A 9000x9000 (81 MP) PNG compresses to a few KB but decodes past 40 MP.
    const bomb = await pngOf(9000, 9000);
    const result = await validateImage(bomb, { declaredMime: 'image/png' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIXEL_LIMIT_EXCEEDED');
    }
  });

  it('rejects oversized byte payloads before decoding', async () => {
    const png = await pngOf(64, 64);
    const padded = Buffer.concat([png, Buffer.alloc(21 * 1024 * 1024)]);
    const result = await validateImage(padded);
    expect(result).toMatchObject({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects truncated/corrupted images via real decode', async () => {
    const png = await pngOf(64, 64);
    const truncated = png.subarray(0, 40);
    const result = await validateImage(truncated, { declaredMime: 'image/png' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MALFORMED_IMAGE');
    }
  });

  it('records EXIF orientation when present', async () => {
    const withOrientation = await sharp(await pngOf(60, 40))
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const result = await validateImage(withOrientation);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orientation).toBe(6);
    }
  });
});

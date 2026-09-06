import sharp from 'sharp';

/**
 * Image content validation (M02, architecture §8): magic/MIME consistency,
 * REAL decode (header lies and decompression bombs are caught by the pixel
 * limit), byte/pixel ceilings (input 20 MiB / 40 MP), animation and SVG
 * rejection, and EXIF orientation recording. Runs on quarantine bytes before
 * an upload may become ready (M04 precheck precondition).
 *
 * `timeoutSeconds` bounds libvips processing; on timeout the upload is
 * rejected, never left half-processed.
 */

export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_DECODE_TIMEOUT_SECONDS = 10;

const MAGIC_SIGNATURES: Array<{ mime: string; test: (bytes: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
  {
    mime: 'image/jpeg',
    test: (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff',
  },
  {
    mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export interface ImageValidation {
  mime: string;
  bytes: number;
  width: number;
  height: number;
  /** EXIF orientation (1 = upright); preserved per the single-image protocol. */
  orientation: number;
}

export type ImageValidationResult =
  | { ok: true; value: ImageValidation }
  | { ok: false; code: 'UNSUPPORTED_MEDIA_TYPE' | 'PAYLOAD_TOO_LARGE' | 'PIXEL_LIMIT_EXCEEDED' | 'MALFORMED_IMAGE'; message: string };

function magicMime(bytes: Buffer): string | null {
  for (const signature of MAGIC_SIGNATURES) {
    if (bytes.length >= 12 && signature.test(bytes)) {
      return signature.mime;
    }
  }
  return null;
}

export async function validateImage(
  bytes: Buffer,
  options: {
    declaredMime?: string;
    maxBytes?: number;
    maxPixels?: number;
    timeoutSeconds?: number;
  } = {},
): Promise<ImageValidationResult> {
  const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
  const maxPixels = options.maxPixels ?? MAX_INPUT_PIXELS;

  if (bytes.length === 0 || bytes.length > maxBytes) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: `byte limit is ${maxBytes}` };
  }

  const magic = magicMime(bytes);
  if (magic === null) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'magic bytes are not JPEG/PNG/WebP' };
  }
  if (options.declaredMime !== undefined && options.declaredMime !== magic) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: `declared ${options.declaredMime} but content is ${magic}`,
    };
  }

  // Real decode with hard pixel ceiling and timeout — catches dimension lies
  // and decompression bombs. Gif/SVG/animated inputs fail either the magic
  // check or the strict format filter below.
  try {
    const metadata = await sharp(bytes, { limitInputPixels: maxPixels })
      .timeout({ seconds: options.timeoutSeconds ?? DEFAULT_DECODE_TIMEOUT_SECONDS })
      .metadata();
    const format = metadata.format;
    if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
      return {
        ok: false,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `format ${String(format)} is not accepted (no SVG/animation/archive)`,
      };
    }
    if ((metadata.pages ?? 1) > 1) {
      return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'animated images are rejected' };
    }
    if (metadata.width === undefined || metadata.height === undefined) {
      return { ok: false, code: 'MALFORMED_IMAGE', message: 'dimensions unavailable' };
    }
    const pixels = metadata.width * metadata.height;
    if (pixels > maxPixels) {
      return { ok: false, code: 'PIXEL_LIMIT_EXCEEDED', message: `pixel limit is ${maxPixels}` };
    }
    return {
      ok: true,
      value: {
        mime: magic,
        bytes: bytes.length,
        width: metadata.width,
        height: metadata.height,
        orientation: metadata.orientation ?? 1,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel/i.test(message)) {
      return { ok: false, code: 'PIXEL_LIMIT_EXCEEDED', message: 'pixel limit exceeded' };
    }
    return { ok: false, code: 'MALFORMED_IMAGE', message: 'image failed to decode' };
  }
}

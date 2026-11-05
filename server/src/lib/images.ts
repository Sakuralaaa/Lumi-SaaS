import sharp from 'sharp';
import { createHash } from 'node:crypto';

sharp.cache(false);
const MAX_PIXELS = 50_000_000;

export class BadImage extends Error {}

/**
 * Decodes untrusted bytes with sharp (rejects anything that is not a real raster image),
 * auto-rotates, strips all metadata and re-encodes. Output never contains the original bytes,
 * which defeats polyglot files and EXIF payloads.
 */
export async function sanitizeUpload(buf: Buffer) {
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  } catch { throw new BadImage('无法识别的图片'); }
  if (!meta.format || !['jpeg', 'png', 'webp', 'heif', 'avif'].includes(meta.format)) throw new BadImage('只支持 JPG、PNG、WEBP、HEIC');
  if ((meta.width ?? 0) < 64 || (meta.height ?? 0) < 64) throw new BadImage('图片太小');
  const pipeline = sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
  const keepAlpha = meta.hasAlpha;
  const out = keepAlpha
    ? await pipeline.png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return {
    data: out.data, width: out.info.width, height: out.info.height,
    mime: keepAlpha ? 'image/png' : 'image/jpeg', ext: keepAlpha ? 'png' : 'jpg',
    sha256: createHash('sha256').update(out.data).digest('hex'),
  };
}

/** Validates upstream output and normalizes to PNG/JPEG without metadata. */
export async function sanitizeOutput(buf: Buffer) {
  const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata().catch(() => null);
  if (!meta?.format) throw new BadImage('upstream returned non-image');
  const png = meta.format === 'png';
  const out = png
    ? await sharp(buf).png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true })
    : await sharp(buf).jpeg({ quality: 94, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return {
    data: out.data, width: out.info.width, height: out.info.height,
    mime: png ? 'image/png' : 'image/jpeg', ext: png ? 'png' : 'jpg',
    sha256: createHash('sha256').update(out.data).digest('hex'),
  };
}

export async function thumbnail(buf: Buffer, size = 512) {
  return sharp(buf).resize({ width: size, height: size, fit: 'inside' }).webp({ quality: 80 }).toBuffer();
}

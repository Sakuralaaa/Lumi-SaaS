import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { hmac, safeEqual } from './crypto.js';

const KEY_RE = /^[a-z]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
export const isValidKey = (k: string) => KEY_RE.test(k);

let s3: S3Client | null = null;
if (config.STORAGE_DRIVER === 's3') {
  if (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) throw new Error('S3 config incomplete');
  s3 = new S3Client({
    region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
  });
}
const localRoot = resolve(config.STORAGE_LOCAL_DIR);
function localPath(key: string) {
  if (!isValidKey(key)) throw new Error('bad key');
  const p = resolve(localRoot, key);
  if (!p.startsWith(localRoot + sep)) throw new Error('bad key');
  return p;
}

export async function putObject(key: string, body: Buffer, mime: string) {
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: mime, CacheControl: 'private, max-age=31536000, immutable' }));
  } else {
    const p = localPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { mode: 0o600 });
  }
}

export async function getObject(key: string): Promise<Buffer> {
  if (s3) {
    const r = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  return readFile(localPath(key));
}

/** Delete objects (idempotent: missing keys are fine). Returns how many keys failed to delete. */
export async function deleteObjects(keys: string[]): Promise<number> {
  const valid = keys.filter(isValidKey);
  let failed = keys.length - valid.length;
  if (s3) {
    for (let i = 0; i < valid.length; i += 1000) {
      const r = await s3.send(new DeleteObjectsCommand({
        Bucket: config.S3_BUCKET, Delete: { Objects: valid.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }));
      failed += r.Errors?.length ?? 0;
    }
    return failed;
  }
  for (const k of valid) {
    try { await unlink(localPath(k)); } catch (e: any) { if (e?.code !== 'ENOENT') failed++; }
  }
  return failed;
}

/** Thumbnail key for an original (uploads/… or outputs/… → thumbs/….webp). */
export const thumbKey = (key: string) => key.replace(/^[a-z]+\//, 'thumbs/').replace(/\.(png|jpg|webp)$/, '.webp');

/** Short-lived URL. S3: presigned. Local: HMAC-signed route served by /files. */
export async function signedUrl(key: string, opts: { ttl?: number; download?: string } = {}): Promise<string> {
  const ttl = opts.ttl ?? 900;
  if (s3) {
    return getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.S3_BUCKET, Key: key,
      ResponseContentDisposition: opts.download ? `attachment; filename="${opts.download.replace(/[^\w.-]/g, '_')}"` : undefined,
    }), { expiresIn: ttl });
  }
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const dl = opts.download ? '1' : '0';
  const sig = hmac(`${key}|${exp}|${dl}`);
  return `/files/${key}?exp=${exp}&dl=${dl}&sig=${sig}`;
}

export function verifyLocalSignature(key: string, exp: string, dl: string, sig: string): boolean {
  if (!isValidKey(key) || !/^\d+$/.test(exp) || !['0', '1'].includes(dl)) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(hmac(`${key}|${exp}|${dl}`), sig);
}

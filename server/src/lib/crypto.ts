import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const keys = new Map<number, Buffer>();
keys.set(config.MASTER_KEY_VERSION, Buffer.from(config.MASTER_KEY, 'base64'));
for (const part of config.MASTER_KEYS_OLD.split(',').filter(Boolean)) {
  const [v, k] = part.split(':');
  const buf = Buffer.from(k, 'base64');
  if (buf.length === 32) keys.set(Number(v), buf);
}

/** AES-256-GCM. Layout: iv(12) | tag(16) | ciphertext */
export function encryptSecret(plain: string): { enc: Buffer; version: number } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.get(config.MASTER_KEY_VERSION)!, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { enc: Buffer.concat([iv, c.getAuthTag(), ct]), version: config.MASTER_KEY_VERSION };
}

export function decryptSecret(enc: Buffer, version: number): string {
  const key = keys.get(version);
  if (!key) throw new Error(`master key v${version} not loaded`);
  const d = createDecipheriv('aes-256-gcm', key, enc.subarray(0, 12));
  d.setAuthTag(enc.subarray(12, 28));
  return Buffer.concat([d.update(enc.subarray(28)), d.final()]).toString('utf8');
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hmac(data: string): string {
  return createHmac('sha256', config.APP_SECRET).update(data).digest('base64url');
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function inviteCode(len = 12): string {
  const out: string[] = [];
  while (out.length < len) {
    const b = randomBytes(len * 2);
    for (const x of b) {
      if (x < 256 - (256 % ALPHABET.length)) out.push(ALPHABET[x % ALPHABET.length]);
      if (out.length === len) break;
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`;
}

/** Strong, readable temporary password: 4 groups of 5 from a 54-char unambiguous alphabet (~115 bits). */
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function tempPassword(): string {
  const out: string[] = [];
  const limit = 256 - (256 % PW_ALPHABET.length);
  while (out.length < 20) {
    for (const x of randomBytes(40)) {
      if (x < limit) out.push(PW_ALPHABET[x % PW_ALPHABET.length]);
      if (out.length === 20) break;
    }
  }
  return [0, 5, 10, 15].map((i) => out.slice(i, i + 5).join('')).join('-');
}

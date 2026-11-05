import { z } from 'zod';

const bool = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  // Public origin of the web app, e.g. https://app.example.com. Used for CSRF origin checks.
  PUBLIC_ORIGIN: z.string().url(),
  // 32+ random bytes, base64. Signs local file URLs.
  APP_SECRET: z.string().min(32),
  // Exactly 32 bytes, base64. Encrypts upstream API keys (AES-256-GCM).
  MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY must be 32 bytes base64'),
  MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),
  // Older keys for rotation: "1:base64,2:base64"
  MASTER_KEYS_OLD: z.string().default(''),
  COOKIE_SECURE: bool.default(true),
  // Reverse proxy trust for req.ip (rate limits, audit). 'false' | 'true' (trust all hops — only if the
  // API port is unreachable except via the proxy) | hop count e.g. '1' (recommended behind one Caddy) |
  // comma-separated proxy IPs/CIDRs e.g. '172.16.0.0/12,10.0.0.0/8'.
  TRUST_PROXY: z.string().default('false').transform((v): boolean | number | string[] => {
    const t = v.trim().toLowerCase();
    if (t === '' || t === 'false' || t === '0') return false;
    if (t === 'true') return true;
    if (/^\d+$/.test(t)) return Number(t);
    return t.split(',').map((x) => x.trim()).filter(Boolean);
  }),
  // Days user uploads / generated images are kept before cron deletes them.
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // Generic JSON webhook (飞书 / 企业微信 / Discord / Slack / anything) for ops alerts.
  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  // Dev only: route upstream calls through HTTP(S)_PROXY env. SSRF host checks still apply.
  UPSTREAM_USE_ENV_PROXY: bool.default(false),
  // Dev only: allow upstream base URLs on private networks / plain http.
  UPSTREAM_ALLOW_PRIVATE: bool.default(false),
  WEB_DIST_DIR: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  process.exit(1);
}
export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
if (isProd && (config.UPSTREAM_ALLOW_PRIVATE || !config.COOKIE_SECURE)) {
  console.error('Refusing to start: UPSTREAM_ALLOW_PRIVATE must be off and COOKIE_SECURE on in production');
  process.exit(1);
}
if (isProd) {
  const problems: string[] = [];
  const weak = (v: string) => /change|example|secret|password|xxxx|todo/i.test(v) || new Set(v).size < 12;
  if (weak(config.APP_SECRET)) problems.push('APP_SECRET looks like a placeholder / low entropy (use: openssl rand -base64 48)');
  const mk = Buffer.from(config.MASTER_KEY, 'base64');
  if (new Set(mk).size < 12) problems.push('MASTER_KEY looks low entropy (use: openssl rand -base64 32)');
  if (!config.PUBLIC_ORIGIN.startsWith('https://')) problems.push('PUBLIC_ORIGIN must be https:// in production');
  if (/CHANGE_ME/i.test(config.DATABASE_URL)) problems.push('DATABASE_URL still contains CHANGE_ME');
  if (problems.length) {
    console.error('Refusing to start in production:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  if (config.TRUST_PROXY === false) console.warn('[config] TRUST_PROXY is off: behind a reverse proxy every client shares one rate-limit bucket. Set TRUST_PROXY=1 behind Caddy.');
  if (config.ADMIN_PASSWORD) console.warn('[config] ADMIN_PASSWORD is still set; remove it from the env after the first admin exists.');
}

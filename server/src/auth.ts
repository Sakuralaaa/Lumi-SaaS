import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { config, isProd } from './config.js';
import { pool, one } from './db/pool.js';
import { randomToken, sha256 } from './lib/crypto.js';
import { HttpError, forbidden, unauthorized } from './lib/errors.js';

export const COOKIE = isProd ? '__Host-sid' : 'sid';
const SESSION_DAYS = 14;

export interface SessionUser { id: string; email: string; role: 'user' | 'admin'; status: string; display_name: string | null; mustChangePassword: boolean }
declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null; sessionHash: string | null }
}

// argon2id, OWASP-recommended parameters
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (p: string) => hash(p, ARGON);
export const verifyPassword = (h: string, p: string) => verify(h, p).catch(() => false);
// Constant-ish work when the user does not exist, to avoid user enumeration via timing.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');
export const verifyDummy = (p: string) => verifyPassword(DUMMY_HASH, p);

export async function createSession(reply: FastifyReply, req: FastifyRequest, userId: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await pool.query('INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
    [sha256(token), userId, expires, req.ip, (req.headers['user-agent'] ?? '').slice(0, 300)]);
  reply.setCookie(COOKIE, token, {
    httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/', expires,
  });
}

export async function destroySession(reply: FastifyReply, req: FastifyRequest) {
  if (req.sessionHash) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.sessionHash]);
  reply.clearCookie(COOKIE, { path: '/' });
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);

  app.addHook('onRequest', async (req) => {
    // CSRF: state-changing requests must come from our own origin and carry a custom header
    // (which browsers cannot send cross-site without a CORS preflight we never approve).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.url.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== config.PUBLIC_ORIGIN) throw new HttpError(403, 'csrf', '来源不被允许');
      if (req.headers['x-requested-with'] !== 'lumi') throw new HttpError(403, 'csrf', '请求被拒绝');
    }
    const token = req.cookies[COOKIE];
    if (!token || token.length > 100) return;
    const h = sha256(token);
    const row = await one<Omit<SessionUser, 'mustChangePassword'> & { must_change_password: boolean; expires_at: Date; last_seen_at: Date }>(pool,
      `SELECT u.id, u.email, u.role, u.status, u.display_name, u.must_change_password, s.expires_at, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [h]);
    if (!row || row.status !== 'active') return;
    req.user = { id: row.id, email: row.email, role: row.role, status: row.status, display_name: row.display_name, mustChangePassword: !!row.must_change_password };
    req.sessionHash = h;
    if (Date.now() - new Date(row.last_seen_at).getTime() > 3600_000) {
      pool.query(`UPDATE sessions SET last_seen_at=now(), expires_at=now() + interval '${SESSION_DAYS} days' WHERE token_hash=$1`, [h]).catch(() => {});
    }
    // After an admin password reset, only auth endpoints and /api/me work until the password is changed.
    if (req.user.mustChangePassword && req.url.startsWith('/api/')) {
      const path = req.url.split('?')[0];
      if (!path.startsWith('/api/auth/') && path !== '/api/me' && path !== '/api/health') {
        throw new HttpError(403, 'must_change_password', '请先修改密码');
      }
    }
  });
}

export async function requireUser(req: FastifyRequest) { if (!req.user) throw unauthorized(); }
export async function requireAdmin(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'admin') throw forbidden();
}

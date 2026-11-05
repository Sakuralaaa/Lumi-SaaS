import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, tx } from '../db/pool.js';
import { createSession, destroySession, hashPassword, requireUser, verifyDummy, verifyPassword } from '../auth.js';
import { bad, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { changeCredits } from '../services/credits.js';
import { getSettings } from '../lib/settings.js';
import { redis } from '../queue.js';
import { sha256 } from '../lib/crypto.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, '密码至少 8 位').max(128);

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const body = z.object({
      email, password,
      inviteCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{6,32}$/, '邀请码格式不正确'),
      displayName: z.string().trim().max(40).optional(),
    }).parse(req.body);
    const s = await getSettings();
    if (!s.signup_enabled) throw new HttpError(403, 'signup_closed', '暂未开放注册');
    const pwHash = await hashPassword(body.password);

    const user = await tx(async (c) => {
      // Lock the code row so concurrent registrations cannot exceed max_uses.
      const code = await one<any>(c, 'SELECT * FROM invite_codes WHERE code=$1 FOR UPDATE', [body.inviteCode]);
      if (!code || code.status !== 'active' || code.used_count >= code.max_uses || (code.expires_at && new Date(code.expires_at) < new Date())) {
        throw bad('邀请码无效或已用完', 'invalid_invite');
      }
      const exists = await one(c, 'SELECT 1 FROM users WHERE email=$1', [body.email]);
      if (exists) throw bad('该邮箱已注册', 'email_taken');
      const u = await one<any>(c,
        `INSERT INTO users(email, password_hash, display_name, invite_code_id, daily_limit)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, email, role`,
        [body.email, pwHash, body.displayName || null, code.id, code.daily_limit]);
      await c.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE id=$1', [code.id]);
      await c.query('INSERT INTO invite_redemptions(invite_code_id, user_id) VALUES ($1,$2)', [code.id, u.id]);
      const grant = code.credits || s.beta_default_credits;
      if (grant > 0) await changeCredits(c, { userId: u.id, delta: grant, reason: 'invite_grant', note: 'invite' });
      await audit({ actorId: u.id, action: 'user.register', targetType: 'invite_code', targetId: code.id, ip: req.ip }, c);
      return u;
    });
    await createSession(reply, req, user.id);
    return { ok: true };
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const body = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
    // Per-account lockout, independent of IP, against distributed guessing.
    const lockKey = `login_fail:${sha256(body.email)}`;
    if (Number(await redis.get(lockKey)) >= 10) throw new HttpError(429, 'locked', '尝试次数过多，请 15 分钟后再试');
    const u = await one<any>(pool, 'SELECT id, password_hash, status FROM users WHERE email=$1', [body.email]);
    const ok = u ? await verifyPassword(u.password_hash, body.password) : await verifyDummy(body.password);
    if (!u || !ok || u.status !== 'active') {
      await redis.multi().incr(lockKey).expire(lockKey, 900).exec();
      await audit({ actorId: u?.id ?? null, action: 'user.login_failed', ip: req.ip, meta: { email: body.email } });
      throw new HttpError(401, 'invalid_login', '邮箱或密码不正确');
    }
    await redis.del(lockKey);
    await pool.query('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    await createSession(reply, req, u.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(reply, req);
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: requireUser, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = z.object({ current: z.string().min(1).max(128), next: password }).parse(req.body);
    const u = await one<any>(pool, 'SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (!u || !(await verifyPassword(u.password_hash, body.current))) throw bad('当前密码不正确');
    if (body.next === body.current) throw bad('新密码不能与当前密码相同', 'same_password');
    await pool.query('UPDATE users SET password_hash=$2, must_change_password=false WHERE id=$1', [req.user!.id, await hashPassword(body.next)]);
    // Invalidate every session, then issue a fresh one for this browser.
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [req.user!.id]);
    await createSession(reply, req, req.user!.id);
    await audit({ actorId: req.user!.id, action: 'user.password_change', ip: req.ip });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    if (!req.user) return { user: null };
    const u = await one<any>(pool, 'SELECT id, email, display_name, role, credits, daily_limit, must_change_password FROM users WHERE id=$1', [req.user.id]);
    if (!u) return { user: null };
    const { must_change_password, ...rest } = u;
    return { user: { ...rest, mustChangePassword: !!must_change_password } };
  });
}

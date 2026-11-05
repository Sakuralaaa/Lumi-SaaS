import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, one, many, tx } from '../db/pool.js';
import { requireAdmin, hashPassword } from '../auth.js';
import { redis } from '../queue.js';
import { bad, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { encryptSecret, decryptSecret, inviteCode, tempPassword, sha256 } from '../lib/crypto.js';
import { assertSafeUpstreamUrl } from '../lib/ssrf.js';
import { getSettings, invalidateSettings, settingsUpdateSchema } from '../lib/settings.js';
import { changeCredits } from '../services/credits.js';
import { listModels, isImageModel, isChatModel } from '../services/adapters/index.js';
import { signedUrl, thumbKey } from '../lib/storage.js';

const uuid = z.string().uuid();
const log = (req: FastifyRequest, action: string, targetType?: string, targetId?: string, meta?: object) =>
  audit({ actorId: req.user!.id, action, targetType, targetId, ip: req.ip, meta });

const capsSchema = z.object({
  ratios: z.array(z.string().regex(/^\d{1,2}:\d{1,2}$/)).max(10).optional(),
  hd: z.boolean().optional(),
  max_refs: z.number().int().min(0).max(16).optional(),
  edit: z.boolean().optional(),
  transparent: z.boolean().optional(),  // can return a transparent PNG background
  mask: z.boolean().optional(),         // honours an inpainting mask
  n_max: z.number().int().min(1).max(10).optional(), // max images per upstream call
});

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  // ---------- dashboard ----------
  app.get('/api/admin/stats', async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    const daily = await many(pool, `
      SELECT to_char(date_trunc('day', i.created_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE i.status='succeeded')::int AS images,
             count(*) FILTER (WHERE i.status='failed')::int AS failed,
             COALESCE(sum(i.credits) FILTER (WHERE i.status='succeeded'),0)::int AS credits,
             COALESCE(sum(i.cost_fen) FILTER (WHERE i.status='succeeded'),0)::float AS cost_fen
        FROM job_items i WHERE i.created_at > now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1`, [days]);
    const byModel = await many(pool, `
      SELECT COALESCE(used_model, planned_model) AS model, count(*) FILTER (WHERE status='succeeded')::int AS ok,
             count(*) FILTER (WHERE status='failed')::int AS failed, avg(upstream_ms) FILTER (WHERE status='succeeded')::int AS avg_ms,
             count(*) FILTER (WHERE fallback)::int AS fallbacks
        FROM job_items WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1`, [days]);
    const prefs = await many(pool, `
      SELECT COALESCE(i.used_model, i.planned_model) AS model, f.action, count(*)::int AS n
        FROM generation_feedback f JOIN job_items i ON i.id=f.item_id
       WHERE f.created_at > now() - ($1 || ' days')::interval GROUP BY 1,2`, [days]);
    const totals = await one(pool, `SELECT (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users WHERE last_login_at > now() - interval '7 days') AS active7,
      (SELECT count(*)::int FROM job_items WHERE status IN ('queued','running')) AS in_flight`);
    return { daily, byModel, prefs, totals };
  });

  // ---------- users ----------
  app.get('/api/admin/users', async (req) => {
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    return many(pool, `SELECT u.id, u.email, u.display_name, u.role, u.status, u.must_change_password, u.credits, u.daily_limit, u.concurrency_override,
        u.created_at, u.last_login_at, ic.code AS invite_code,
        (SELECT count(*)::int FROM job_items i WHERE i.user_id=u.id AND i.status='succeeded') AS images
      FROM users u LEFT JOIN invite_codes ic ON ic.id=u.invite_code_id
      WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%') ORDER BY u.created_at DESC LIMIT 200`, [q.q ?? null]);
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      status: z.enum(['active', 'disabled']).optional(),
      role: z.enum(['user', 'admin']).optional(),
      dailyLimit: z.number().int().min(0).max(10000).nullable().optional(),
      concurrencyOverride: z.number().int().min(1).max(50).nullable().optional(),
    }).parse(req.body);
    if (id === req.user!.id && (b.status === 'disabled' || b.role === 'user')) throw bad('不能停用或降级自己');
    const u = await one(pool, 'SELECT id FROM users WHERE id=$1', [id]);
    if (!u) throw notFound();
    await pool.query(`UPDATE users SET
        status = COALESCE($2, status), role = COALESCE($3, role),
        daily_limit = CASE WHEN $4::boolean THEN $5 ELSE daily_limit END,
        concurrency_override = CASE WHEN $6::boolean THEN $7 ELSE concurrency_override END
      WHERE id=$1`, [id, b.status ?? null, b.role ?? null, b.dailyLimit !== undefined, b.dailyLimit ?? null, b.concurrencyOverride !== undefined, b.concurrencyOverride ?? null]);
    if (b.status === 'disabled' || b.role) await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await log(req, 'admin.user_update', 'user', id, b);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/credits', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ delta: z.number().int().min(-100000).max(100000).refine((v) => v !== 0), note: z.string().trim().min(1).max(200) }).parse(req.body);
    const balance = await tx(async (c) => {
      const bal = await changeCredits(c, { userId: id, delta: b.delta, reason: 'admin_adjust', actorId: req.user!.id, note: b.note });
      await audit({ actorId: req.user!.id, action: 'admin.credits_adjust', targetType: 'user', targetId: id, ip: req.ip, meta: b }, c);
      return bal;
    });
    return { balance };
  });

  /** Reset a user's password to a one-time temporary password (returned once, never stored or logged). */
  app.post('/api/admin/users/:id/reset-password', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (id === req.user!.id) throw bad('不能重置自己的密码，请使用「修改密码」');
    const u = await one<any>(pool, 'SELECT id, email, role FROM users WHERE id=$1', [id]);
    if (!u) throw notFound();
    const pw = tempPassword();
    const pwHash = await hashPassword(pw);
    await tx(async (c) => {
      await c.query('UPDATE users SET password_hash=$2, must_change_password=true WHERE id=$1', [id, pwHash]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit({ actorId: req.user!.id, action: 'admin.user_password_reset', targetType: 'user', targetId: id, ip: req.ip,
        meta: { email: u.email, targetRole: u.role } }, c);
    });
    await redis.del(`login_fail:${sha256(String(u.email).toLowerCase())}`).catch(() => {});
    reply.header('Cache-Control', 'no-store');
    return { tempPassword: pw, mustChangePassword: true };
  });

  app.get('/api/admin/users/:id/ledger', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return many(pool, 'SELECT * FROM credit_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 200', [id]);
  });

  // ---------- invite codes ----------
  app.get('/api/admin/invites', async (req) => {
    const q = z.object({ batch: z.string().max(60).optional() }).parse(req.query);
    return many(pool, `SELECT ic.*, (SELECT array_agg(u.email::text) FROM users u WHERE u.invite_code_id=ic.id) AS used_by
      FROM invite_codes ic WHERE ($1::text IS NULL OR ic.batch=$1) ORDER BY ic.created_at DESC LIMIT 500`, [q.batch ?? null]);
  });

  app.post('/api/admin/invites', async (req) => {
    const b = z.object({
      count: z.number().int().min(1).max(200),
      credits: z.number().int().min(0).max(100000),
      maxUses: z.number().int().min(1).max(1000).default(1),
      dailyLimit: z.number().int().min(0).max(10000).nullable().default(null),
      expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
      batch: z.string().trim().max(60).optional(),
      note: z.string().trim().max(200).optional(),
    }).parse(req.body);
    const codes = await tx(async (c) => {
      const out: string[] = [];
      for (let i = 0; i < b.count; i++) {
        const code = inviteCode();
        await c.query(`INSERT INTO invite_codes(code, credits, max_uses, daily_limit, expires_at, batch, note, created_by)
          VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' days')::interval END, $6,$7,$8)`,
          [code, b.credits, b.maxUses, b.dailyLimit, b.expiresInDays, b.batch ?? null, b.note ?? null, req.user!.id]);
        out.push(code);
      }
      await audit({ actorId: req.user!.id, action: 'admin.invites_create', ip: req.ip, meta: { ...b } }, c);
      return out;
    });
    return { codes };
  });

  app.post('/api/admin/invites/revoke', async (req) => {
    const b = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(req.body);
    const r = await pool.query(`UPDATE invite_codes SET status='revoked' WHERE id = ANY($1::uuid[])`, [b.ids]);
    await log(req, 'admin.invites_revoke', 'invite_code', undefined, { ids: b.ids });
    return { revoked: r.rowCount };
  });

  // ---------- upstream channels (keys are write-only) ----------
  app.get('/api/admin/channels', async () =>
    many(pool, 'SELECT id, name, vendor, purpose, base_url, key_last4, status, timeout_ms, created_at, updated_at FROM upstream_channels ORDER BY created_at'));

  const channelBody = z.object({
    name: z.string().trim().min(1).max(60),
    vendor: z.enum(['gptchat2api', 'grok2api', 'openai_compat']),
    purpose: z.enum(['image', 'chat']).default('image'),
    baseUrl: z.string().trim().max(300),
    apiKey: z.string().trim().min(1).max(500).optional(),
    status: z.enum(['active', 'disabled']).default('active'),
    timeoutMs: z.number().int().min(10_000).max(600_000).default(300_000),
  });

  app.post('/api/admin/channels', async (req) => {
    const b = channelBody.extend({ apiKey: z.string().trim().min(1).max(500) }).parse(req.body);
    const url = await assertSafeUpstreamUrl(b.baseUrl).catch((e) => { throw bad(e.message); });
    const { enc, version } = encryptSecret(b.apiKey);
    const row = await one<any>(pool, `INSERT INTO upstream_channels(name, vendor, base_url, api_key_enc, key_version, key_last4, status, timeout_ms, purpose)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [b.name, b.vendor, url.toString().replace(/\/+$/, ''), enc, version, b.apiKey.slice(-4), b.status, b.timeoutMs, b.purpose]);
    await log(req, 'admin.channel_create', 'channel', row.id, { name: b.name, vendor: b.vendor, purpose: b.purpose, baseUrl: b.baseUrl });
    return { id: row.id };
  });

  app.patch('/api/admin/channels/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = channelBody.extend({ purpose: z.enum(['image', 'chat']).optional(), status: z.enum(['active', 'disabled']).optional(),
      timeoutMs: z.number().int().min(10_000).max(600_000).optional() }).partial().parse(req.body);
    const cur = await one<any>(pool, 'SELECT * FROM upstream_channels WHERE id=$1', [id]);
    if (!cur) throw notFound();
    const baseUrl = b.baseUrl ? (await assertSafeUpstreamUrl(b.baseUrl).catch((e) => { throw bad(e.message); })).toString().replace(/\/+$/, '') : cur.base_url;
    const key = b.apiKey ? encryptSecret(b.apiKey) : null;
    await pool.query(`UPDATE upstream_channels SET name=$2, vendor=$3, base_url=$4, status=$5, timeout_ms=$6,
        api_key_enc=COALESCE($7, api_key_enc), key_version=COALESCE($8, key_version), key_last4=COALESCE($9, key_last4), purpose=$10, updated_at=now() WHERE id=$1`,
      [id, b.name ?? cur.name, b.vendor ?? cur.vendor, baseUrl, b.status ?? cur.status, b.timeoutMs ?? cur.timeout_ms,
        key?.enc ?? null, key?.version ?? null, b.apiKey ? b.apiKey.slice(-4) : null, b.purpose ?? cur.purpose]);
    await log(req, 'admin.channel_update', 'channel', id, { ...b, apiKey: b.apiKey ? '***' : undefined });
    return { ok: true };
  });

  app.delete('/api/admin/channels/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await pool.query('DELETE FROM upstream_channels WHERE id=$1', [id]);
    await log(req, 'admin.channel_delete', 'channel', id);
    return { ok: true };
  });

  /** Sync GET /v1/models: insert new image models (disabled by default), never auto-enable. Chat (planner-only) channels create none. */
  app.post('/api/admin/channels/:id/sync', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ch = await one<any>(pool, 'SELECT * FROM upstream_channels WHERE id=$1', [id]);
    if (!ch) throw notFound();
    let ids: string[];
    try { ids = await listModels({ baseUrl: ch.base_url, apiKey: decryptSecret(ch.api_key_enc, ch.key_version) }); }
    catch (e: any) { throw bad(`同步失败：${String(e.message).slice(0, 100)}`); }
    if (ch.purpose === 'chat') {
      await log(req, 'admin.channel_sync', 'channel', id, { count: 0, purpose: 'chat' });
      return { total: ids.length, imageModels: [], chatModels: ids.filter(isChatModel), purpose: 'chat' };
    }
    const images = ids.filter(isImageModel);
    for (const m of images) {
      await pool.query(`INSERT INTO real_models(channel_id, model_id) VALUES ($1,$2)
        ON CONFLICT (channel_id, model_id) DO UPDATE SET synced_at=now()`, [id, m]);
    }
    await log(req, 'admin.channel_sync', 'channel', id, { count: images.length });
    return { total: ids.length, imageModels: images, purpose: 'image' };
  });

  /** All model ids the channel's GET /v1/models returns (live, SSRF-guarded); used to pick the planner chat model. Not persisted. */
  app.get('/api/admin/channels/:id/models', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ch = await one<any>(pool, 'SELECT * FROM upstream_channels WHERE id=$1', [id]);
    if (!ch) throw notFound();
    let ids: string[];
    try { ids = await listModels({ baseUrl: ch.base_url, apiKey: decryptSecret(ch.api_key_enc, ch.key_version) }); }
    catch (e: any) { throw bad(`获取模型失败：${String(e.message).slice(0, 100)}`); }
    return { all: ids, chat: ids.filter(isChatModel), image: ids.filter(isImageModel) };
  });

  // ---------- real models ----------
  app.get('/api/admin/models', async () =>
    many(pool, `SELECT rm.*, ch.name AS channel_name, ch.vendor, ch.purpose FROM real_models rm JOIN upstream_channels ch ON ch.id=rm.channel_id ORDER BY ch.name, rm.model_id`));

  app.patch('/api/admin/models/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      enabled: z.boolean().optional(), caps: capsSchema.optional(),
      costStandardFen: z.number().min(0).max(10000).optional(), costHdFen: z.number().min(0).max(10000).optional(),
    }).parse(req.body);
    const r = await pool.query(`UPDATE real_models SET enabled=COALESCE($2,enabled), caps=COALESCE($3,caps),
      cost_standard_fen=COALESCE($4,cost_standard_fen), cost_hd_fen=COALESCE($5,cost_hd_fen) WHERE id=$1`,
      [id, b.enabled ?? null, b.caps ? JSON.stringify(b.caps) : null, b.costStandardFen ?? null, b.costHdFen ?? null]);
    if (!r.rowCount) throw notFound();
    await log(req, 'admin.model_update', 'real_model', id, b);
    return { ok: true };
  });

  // ---------- platform models & bindings ----------
  app.get('/api/admin/platform-models', async () => {
    const pms = await many<any>(pool, 'SELECT * FROM platform_models ORDER BY key');
    const binds = await many<any>(pool, `SELECT rb.*, rm.model_id, ch.name AS channel_name FROM route_bindings rb
      JOIN real_models rm ON rm.id=rb.real_model_id JOIN upstream_channels ch ON ch.id=rm.channel_id ORDER BY rb.priority`);
    return pms.map((p) => ({ ...p, bindings: binds.filter((b) => b.platform_model_key === p.key) }));
  });

  app.post('/api/admin/bindings', async (req) => {
    const b = z.object({ platformModelKey: z.string().max(40), realModelId: uuid, priority: z.number().int().min(1).max(100).default(1), weight: z.number().int().min(1).max(1000).default(100) }).parse(req.body);
    const rm = await one<any>(pool, 'SELECT ch.purpose FROM real_models rm JOIN upstream_channels ch ON ch.id=rm.channel_id WHERE rm.id=$1', [b.realModelId]);
    if (!rm) throw notFound();
    if (rm.purpose !== 'image') throw bad('规划（chat）渠道的模型不能绑定到出图模型');
    const row = await one<any>(pool, `INSERT INTO route_bindings(platform_model_key, real_model_id, priority, weight) VALUES ($1,$2,$3,$4)
      ON CONFLICT (platform_model_key, real_model_id) DO UPDATE SET priority=EXCLUDED.priority, weight=EXCLUDED.weight, enabled=true RETURNING id`,
      [b.platformModelKey, b.realModelId, b.priority, b.weight]);
    await log(req, 'admin.binding_upsert', 'binding', row.id, b);
    return { id: row.id };
  });

  app.patch('/api/admin/bindings/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ priority: z.number().int().min(1).max(100).optional(), weight: z.number().int().min(1).max(1000).optional(), enabled: z.boolean().optional() }).parse(req.body);
    await pool.query('UPDATE route_bindings SET priority=COALESCE($2,priority), weight=COALESCE($3,weight), enabled=COALESCE($4,enabled) WHERE id=$1',
      [id, b.priority ?? null, b.weight ?? null, b.enabled ?? null]);
    await log(req, 'admin.binding_update', 'binding', id, b);
    return { ok: true };
  });

  app.delete('/api/admin/bindings/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await pool.query('DELETE FROM route_bindings WHERE id=$1', [id]);
    await log(req, 'admin.binding_delete', 'binding', id);
    return { ok: true };
  });

  // ---------- routing rules ----------
  const ruleBody = z.object({
    name: z.string().trim().min(1).max(60), priority: z.number().int().min(1).max(1000),
    match: z.object({ quality: z.enum(['standard', 'hd']).optional(), min_refs: z.number().int().min(0).max(10).optional(),
      max_refs: z.number().int().min(0).max(10).optional(), tags_any: z.array(z.string().max(30)).max(10).optional() }),
    primaryModel: z.string().max(40), fallbackModel: z.string().max(40).nullable(), enabled: z.boolean().default(true),
  });
  app.get('/api/admin/rules', async () => many(pool, 'SELECT * FROM routing_rules ORDER BY priority'));
  app.post('/api/admin/rules', async (req) => {
    const b = ruleBody.parse(req.body);
    const r = await one<any>(pool, `INSERT INTO routing_rules(name, priority, match, primary_model, fallback_model, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.name, b.priority, JSON.stringify(b.match), b.primaryModel, b.fallbackModel, b.enabled]);
    await log(req, 'admin.rule_create', 'rule', r.id, b);
    return { id: r.id };
  });
  app.put('/api/admin/rules/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = ruleBody.parse(req.body);
    await pool.query(`UPDATE routing_rules SET name=$2, priority=$3, match=$4, primary_model=$5, fallback_model=$6, enabled=$7 WHERE id=$1`,
      [id, b.name, b.priority, JSON.stringify(b.match), b.primaryModel, b.fallbackModel, b.enabled]);
    await log(req, 'admin.rule_update', 'rule', id, b);
    return { ok: true };
  });
  app.delete('/api/admin/rules/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await pool.query('DELETE FROM routing_rules WHERE id=$1', [id]);
    await log(req, 'admin.rule_delete', 'rule', id);
    return { ok: true };
  });

  // ---------- pricing & settings ----------
  app.get('/api/admin/pricing', async () => {
    const rows = await many<any>(pool, 'SELECT quality, credits FROM pricing');
    return Object.fromEntries(rows.map((r) => [r.quality, r.credits]));
  });
  app.put('/api/admin/pricing', async (req) => {
    const b = z.object({ standard: z.number().int().min(1).max(1000), hd: z.number().int().min(1).max(1000) })
      .refine((v) => v.hd >= v.standard, { message: '高清价格不能低于标准' }).parse(req.body);
    const before = Object.fromEntries((await many<any>(pool, 'SELECT quality, credits FROM pricing')).map((r) => [r.quality, r.credits]));
    await pool.query(`INSERT INTO pricing(quality, credits) VALUES ('standard',$1),('hd',$2) ON CONFLICT (quality) DO UPDATE SET credits=EXCLUDED.credits`, [b.standard, b.hd]);
    await log(req, 'admin.pricing_update', 'pricing', undefined, { before, after: b });
    return { ok: true };
  });

  app.get('/api/admin/settings', async () => getSettings());
  app.put('/api/admin/settings', async (req) => {
    const b = settingsUpdateSchema.parse(req.body) as Record<string, unknown>;
    if (typeof b.planner_channel_id === 'string' && b.planner_channel_id
      && !(await one(pool, 'SELECT id FROM upstream_channels WHERE id=$1', [b.planner_channel_id]))) throw bad('规划渠道不存在');
    if (b.concurrency_user === 0 || b.concurrency_global === 0) throw bad('并发不能为 0');
    for (const [k, v] of Object.entries(b)) if (v !== undefined) {
      await pool.query(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(v)]);
    }
    invalidateSettings();
    await log(req, 'admin.settings_update', 'settings', undefined, b);
    return getSettings();
  });

  // ---------- monitoring ----------
  app.get('/api/admin/items', async (req) => {
    const q = z.object({ status: z.enum(['failed', 'succeeded', 'running', 'queued']).optional() }).parse(req.query);
    const rows = await many<any>(pool, `SELECT i.id, i.status, i.ratio, i.planned_model, i.used_model, i.used_quality, i.fallback, i.attempts,
        i.error_code, i.error_message, i.upstream_ms, i.cost_fen, i.credits, i.created_at, u.email, a.storage_key
      FROM job_items i JOIN users u ON u.id=i.user_id LEFT JOIN assets a ON a.id=i.output_asset_id AND a.purged_at IS NULL
      WHERE ($1::text IS NULL OR i.status=$1) ORDER BY i.created_at DESC LIMIT 200`, [q.status ?? null]);
    return Promise.all(rows.map(async (r) => ({ ...r, storage_key: undefined,
      thumb: r.storage_key ? await signedUrl(thumbKey(r.storage_key)) : null })));
  });

  app.get('/api/admin/audit', async () =>
    many(pool, `SELECT a.*, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300`));
}

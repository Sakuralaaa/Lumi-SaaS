import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, one, many } from '../db/pool.js';
import { requireAdmin, requireUser } from '../auth.js';
import { bad, HttpError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getObject, putObject, signedUrl } from '../lib/storage.js';
import { sanitizeUpload, thumbnail, BadImage } from '../lib/images.js';
import { redis } from '../queue.js';
import { getPrices } from '../services/pricing.js';
import { TAGS } from '../services/prompt.js';
import {
  ATTR_GROUP_LABEL, CANDIDATES, DEFAULT_ATTRS, deleteAssetFiles, PORTRAIT_ATTRS, attrsSummary, cleanupStaleCandidates, normalizeAttrs, previewPortraits,
  type AttrKey,
} from '../services/portrait.js';

const uuid = z.string().uuid();
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export const TEMPLATE_CATEGORIES = ['美妆', '服饰', '食品', '数码', '家居', '珠宝', '节日', '通用'] as const;
export const TEMPLATE_PURPOSES = ['主图', '卖点', '场景', '细节', '氛围', '海报'] as const;
const FIELD_KEYS = ['brand', 'headline', 'sub', 'points'] as const;
const PREVIEW_LIMIT_PER_HOUR = 10;
const PREVIEW_TTL = 2 * 3600;

const thumbKey = (storageKey: string) => storageKey.replace(/^[a-z]+\//, 'thumbs/').replace(/\.(png|jpg)$/, '.webp');

/** Copies one stored image into a new asset (new key, new kind/owner). Bytes were sanitized on the way in. */
async function copyAsset(src: { storage_key: string; mime: string; width: number; height: number; bytes: number; sha256: string },
  owner: string, kind: 'portrait' | 'upload' | 'template', prefix: 'portraits' | 'uploads' | 'templates') {
  const id = randomUUID();
  const ext = src.storage_key.endsWith('.png') ? 'png' : 'jpg';
  const key = `${prefix}/${owner}/${id}.${ext}`;
  const buf = await getObject(src.storage_key);
  await putObject(key, buf, src.mime);
  await putObject(`thumbs/${owner}/${id}.webp`, await thumbnail(buf), 'image/webp');
  await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, owner, kind, key, src.mime, src.width, src.height, src.bytes, src.sha256]);
  return { id, key };
}

async function libraryView(r: any) {
  return {
    id: r.id, name: r.name, source: r.source, attrs: r.attrs ?? {}, summary: attrsSummary(r.attrs),
    portraitAssetId: r.portrait_asset_id, createdAt: r.created_at,
    url: await signedUrl(r.storage_key), thumb: await signedUrl(thumbKey(r.storage_key)),
  };
}

async function templateView(r: any, admin = false) {
  const base: any = {
    id: r.id, title: r.title, category: r.category, mode: r.mode, prompt: r.prompt, tags: r.tags, ratios: r.ratios, quality: r.quality,
    descr: r.descr ?? '', purpose: r.purpose ?? '场景', fields: r.fields ?? [], allowText: !!r.allow_text, featured: !!r.featured,
    width: r.width ?? null, height: r.height ?? null,
    cover: await signedUrl(r.storage_key), thumb: await signedUrl(thumbKey(r.storage_key)),
  };
  // scene_prompt is internal and only ever returned to admins.
  if (admin) Object.assign(base, { sort: r.sort, enabled: r.enabled, coverAssetId: r.cover_asset_id, createdAt: r.created_at,
    scenePrompt: r.scene_prompt ?? '', source: r.source ?? '', uses: r.uses ?? 0 });
  return base;
}

const attrsSchema = z.object(Object.fromEntries((Object.keys(PORTRAIT_ATTRS) as AttrKey[]).map((k) => [k, z.string().max(30).optional()]))) as z.ZodType<Partial<Record<AttrKey, string>>>;

const tplFields = {
  title: z.string().trim().min(1, '请填写标题').max(30),
  category: z.enum(TEMPLATE_CATEGORIES),
  mode: z.enum(['simple', 'detailed']),
  coverAssetId: uuid,
  prompt: z.string().trim().max(500),
  tags: z.array(z.string().max(30)).max(6).transform((t) => [...new Set(t.filter((x) => x in TAGS))]),
  ratios: z.array(z.enum(RATIOS)).min(1, '至少选择一个比例').max(4).transform((r) => [...new Set(r)]),
  quality: z.enum(['standard', 'hd']),
  sort: z.number().int().min(-10000).max(10000),
  enabled: z.boolean(),
  scenePrompt: z.string().trim().max(2500),
  allowText: z.boolean(),
  fields: z.array(z.object({ key: z.enum(FIELD_KEYS), label: z.string().trim().min(1).max(10), placeholder: z.string().trim().max(30).default(''),
    max: z.number().int().min(2).max(40).default(16) })).max(3).transform((f) => f.filter((x, i, a) => a.findIndex((y) => y.key === x.key) === i)),
  purpose: z.enum(TEMPLATE_PURPOSES),
  descr: z.string().trim().max(40),
  featured: z.boolean(),
  source: z.string().trim().max(200),
};
const templateBody = z.object({
  ...tplFields,
  prompt: tplFields.prompt.default(''),
  tags: tplFields.tags.default([]),
  quality: tplFields.quality.default('standard'),
  sort: tplFields.sort.default(0),
  enabled: tplFields.enabled.default(true),
  scenePrompt: tplFields.scenePrompt.default(''),
  allowText: tplFields.allowText.default(false),
  fields: tplFields.fields.default([]),
  purpose: tplFields.purpose.default('场景'),
  descr: tplFields.descr.default(''),
  featured: tplFields.featured.default(false),
  source: tplFields.source.default(''),
});
// PATCH: every field optional and NO defaults (an omitted field keeps its stored value).
const templatePatch = z.object(tplFields).partial();

export default async function libraryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/admin/')) await requireAdmin(req);
    else if (req.url.startsWith('/api/public/')) return;
    else if (req.url.startsWith('/api/')) await requireUser(req);
  });

  // Public landing showcase: featured template covers only (no prompts, no ids), short-lived signed thumbs.
  app.get('/api/public/showcase', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const rows = await many<any>(pool, `SELECT t.title, t.category, a.storage_key, a.width, a.height FROM inspiration_templates t
      JOIN assets a ON a.id=t.cover_asset_id WHERE t.enabled AND t.featured ORDER BY t.sort, t.created_at DESC LIMIT 24`);
    reply.header('Cache-Control', 'public, max-age=300');
    return Promise.all(rows.map(async (r) => ({ title: r.title, category: r.category, width: r.width ?? null, height: r.height ?? null,
      thumb: await signedUrl(thumbKey(r.storage_key)) })));
  });
  const log = (req: FastifyRequest, action: string, targetId?: string, meta?: object) =>
    audit({ actorId: req.user!.id, action, targetType: 'template', targetId, ip: req.ip, meta });

  // ================= model library =================
  app.get('/api/models-library/options', async () => {
    const prices = await getPrices();
    const groups = (Object.keys(PORTRAIT_ATTRS) as AttrKey[]).map((k) => ({
      key: k, label: ATTR_GROUP_LABEL[k],
      options: Object.entries(PORTRAIT_ATTRS[k]).map(([v, [l]]) => ({ value: v, label: l })),
    }));
    return { groups, defaults: DEFAULT_ATTRS, candidates: CANDIDATES, unitPrice: prices.standard, cost: prices.standard * CANDIDATES };
  });

  app.get('/api/models-library', async (req) => {
    const q = z.object({ source: z.enum(['ai', 'upload']).optional() }).parse(req.query);
    const rows = await many<any>(pool, `SELECT m.*, a.storage_key FROM model_library m JOIN assets a ON a.id=m.portrait_asset_id AND a.user_id=m.user_id
      WHERE m.user_id=$1 AND NOT m.deleted AND ($2::text IS NULL OR m.source=$2) ORDER BY m.created_at DESC LIMIT 200`, [req.user!.id, q.source ?? null]);
    return Promise.all(rows.map(libraryView));
  });

  // Upload my model: an existing upload of this user + explicit consent → portrait copy (exempt from retention).
  app.post('/api/models-library', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(1, '请填写模特名称').max(30),
      assetId: uuid,
      consent: z.literal(true, { message: '请先确认已获得该模特的肖像使用授权' }),
      attrs: attrsSchema.optional(),
    }).parse(req.body);
    const userId = req.user!.id;
    const src = await one<any>(pool, `SELECT * FROM assets WHERE id=$1 AND user_id=$2 AND kind IN ('upload','portrait') AND purged_at IS NULL`, [b.assetId, userId]);
    if (!src) throw notFound();
    const count = await one<any>(pool, 'SELECT count(*)::int AS n FROM model_library WHERE user_id=$1 AND NOT deleted', [userId]);
    if (count.n >= 200) throw bad('模特库最多保存 200 位模特');
    const copy = await copyAsset(src, userId, 'portrait', 'portraits');
    const attrs = b.attrs ? Object.fromEntries(Object.entries(b.attrs).filter(([k, v]) => v && v in (PORTRAIT_ATTRS as any)[k])) : {};
    const row = await one<any>(pool, `INSERT INTO model_library(user_id, name, source, portrait_asset_id, attrs, consent_confirmed)
      VALUES ($1,$2,'upload',$3,$4,true) RETURNING *`, [userId, b.name, copy.id, JSON.stringify(attrs)]);
    return libraryView({ ...row, storage_key: copy.key });
  });

  app.patch('/api/models-library/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1, '请填写模特名称').max(30) }).parse(req.body);
    const r = await pool.query('UPDATE model_library SET name=$3 WHERE id=$1 AND user_id=$2 AND NOT deleted', [id, req.user!.id, b.name]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  app.delete('/api/models-library/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    // Soft delete: past jobs may still reference the portrait as an input.
    const r = await pool.query('UPDATE model_library SET deleted=true WHERE id=$1 AND user_id=$2 AND NOT deleted', [id, req.user!.id]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  // AI 模特: generate candidates (charged standard price × candidates; failures refunded).
  app.post('/api/models-library/ai/preview', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ attrs: attrsSchema.default({}), note: z.string().max(120).default('') }).parse(req.body);
    const userId = req.user!.id;
    const hourKey = `rl:portrait:${userId}:${Math.floor(Date.now() / 3600_000)}`;
    const n = Number((await redis.multi().incr(hourKey).expire(hourKey, 3700).exec())?.[0]?.[1] ?? 0);
    if (n > PREVIEW_LIMIT_PER_HOUR) throw new HttpError(429, 'rate_limited', `每小时最多生成 ${PREVIEW_LIMIT_PER_HOUR} 次模特，请稍后再试`);
    await cleanupStaleCandidates(userId).catch(() => {});
    const attrs = normalizeAttrs(b.attrs);
    reply.raw.setTimeout?.(150_000);
    const r = await previewPortraits(userId, attrs, b.note);
    const previewId = randomUUID();
    await redis.set(`portrait:pv:${previewId}`, JSON.stringify({ userId, assetIds: r.candidates.map((c) => c.assetId), attrs }), 'EX', PREVIEW_TTL);
    const rows = await many<any>(pool, 'SELECT id, storage_key FROM assets WHERE id = ANY($1::uuid[]) AND user_id=$2', [r.candidates.map((c) => c.assetId), userId]);
    return {
      previewId, charged: r.charged, refunded: r.refunded, credits: r.balance, summary: attrsSummary(attrs),
      candidates: await Promise.all(r.candidates.map(async (c) => {
        const k = rows.find((x) => x.id === c.assetId)!.storage_key;
        return { assetId: c.assetId, width: c.width, height: c.height, url: await signedUrl(k), thumb: await signedUrl(thumbKey(k)) };
      })),
    };
  });

  app.post('/api/models-library/ai/save', async (req) => {
    const b = z.object({ previewId: uuid, assetId: uuid, name: z.string().trim().min(1, '请填写模特名称').max(30) }).parse(req.body);
    const userId = req.user!.id;
    const raw = await redis.get(`portrait:pv:${b.previewId}`);
    const pv = raw ? JSON.parse(raw) as { userId: string; assetIds: string[]; attrs: object } : null;
    if (!pv || pv.userId !== userId || !pv.assetIds.includes(b.assetId)) throw new HttpError(410, 'preview_expired', '候选图已过期，请重新生成');
    // consume once (another tab may race us)
    if ((await redis.del(`portrait:pv:${b.previewId}`)) !== 1) throw new HttpError(410, 'preview_expired', '候选图已过期，请重新生成');
    const a = await one<any>(pool, `SELECT storage_key FROM assets WHERE id=$1 AND user_id=$2 AND kind='portrait'`, [b.assetId, userId]);
    if (!a) throw notFound();
    const row = await one<any>(pool, `INSERT INTO model_library(user_id, name, source, portrait_asset_id, attrs, consent_confirmed)
      VALUES ($1,$2,'ai',$3,$4,false) RETURNING *`, [userId, b.name, b.assetId, JSON.stringify(pv.attrs)]);
    // discard the other candidates (unless something already references them)
    const others = pv.assetIds.filter((x) => x !== b.assetId);
    if (others.length) {
      await pool.query(`DELETE FROM assets a WHERE a.id = ANY($1::uuid[]) AND a.user_id=$2 AND a.kind='portrait'
        AND NOT EXISTS (SELECT 1 FROM model_library m WHERE m.portrait_asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM job_inputs ji WHERE ji.asset_id=a.id) RETURNING a.storage_key`, [others, userId])
        .then((r) => deleteAssetFiles(r.rows.map((x: any) => x.storage_key)));
    }
    return libraryView({ ...row, storage_key: a.storage_key });
  });

  // ================= inspiration templates (user) =================
  app.get('/api/templates', async (req) => {
    const q = z.object({
      category: z.enum(TEMPLATE_CATEGORIES).optional(), purpose: z.enum(TEMPLATE_PURPOSES).optional(),
      q: z.string().trim().max(20).optional(), featured: z.enum(['1']).optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%` : null;
    const rows = await many<any>(pool, `SELECT t.*, a.storage_key, a.width, a.height FROM inspiration_templates t JOIN assets a ON a.id=t.cover_asset_id
      WHERE t.enabled AND ($1::text IS NULL OR t.category=$1) AND ($2::text IS NULL OR t.purpose=$2)
        AND ($3::text IS NULL OR t.title ILIKE $3 OR t.descr ILIKE $3 OR t.category ILIKE $3) AND (NOT $4 OR t.featured)
      ORDER BY t.featured DESC, t.sort, t.created_at DESC LIMIT 300`, [q.category ?? null, q.purpose ?? null, like, q.featured === '1']);
    return Promise.all(rows.map((r) => templateView(r)));
  });

  /** Copies the template cover into the caller's own uploads so it can be used as a style reference input. */
  app.post('/api/templates/:id/use', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one<any>(pool, `SELECT t.*, a.storage_key, a.mime, a.width, a.height, a.bytes, a.sha256 FROM inspiration_templates t
      JOIN assets a ON a.id=t.cover_asset_id WHERE t.id=$1 AND t.enabled`, [id]);
    if (!t) throw notFound();
    // Scene templates carry their own (hidden) scene; their cover shows a sample product, so it is not sent as a reference.
    if (t.scene_prompt) return { template: await templateView(t), style: null };
    const copy = await copyAsset(t, req.user!.id, 'upload', 'uploads');
    return {
      template: await templateView(t),
      style: { id: copy.id, width: t.width, height: t.height, thumb: await signedUrl(`thumbs/${req.user!.id}/${copy.id}.webp`) },
    };
  });

  // ================= inspiration templates (admin) =================
  app.get('/api/admin/templates', async () => {
    const rows = await many<any>(pool, `SELECT t.*, a.storage_key, a.width, a.height FROM inspiration_templates t JOIN assets a ON a.id=t.cover_asset_id
      ORDER BY t.sort, t.created_at DESC LIMIT 500`);
    return Promise.all(rows.map((r) => templateView(r, true)));
  });

  app.post('/api/admin/templates/cover', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const file = await req.file({ limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 } });
    if (!file) throw bad('没有收到文件');
    const buf = await file.toBuffer().catch(() => { throw bad('文件过大，最大 15MB'); });
    if (file.file.truncated) throw bad('文件过大，最大 15MB');
    let img;
    try { img = await sanitizeUpload(buf); } catch (e) { throw bad(e instanceof BadImage ? e.message : '无法处理该图片'); }
    const id = randomUUID();
    const owner = req.user!.id;
    const key = `templates/${owner}/${id}.${img.ext}`;
    await putObject(key, img.data, img.mime);
    await putObject(`thumbs/${owner}/${id}.webp`, await thumbnail(img.data), 'image/webp');
    await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256) VALUES ($1,$2,'template',$3,$4,$5,$6,$7,$8)`,
      [id, owner, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
    return { id, width: img.width, height: img.height, thumb: await signedUrl(`thumbs/${owner}/${id}.webp`) };
  });

  const assertCover = async (assetId: string) => {
    const a = await one(pool, `SELECT 1 FROM assets WHERE id=$1 AND kind='template'`, [assetId]);
    if (!a) throw bad('请先上传封面图');
  };

  app.post('/api/admin/templates', async (req) => {
    const b = templateBody.parse(req.body);
    await assertCover(b.coverAssetId);
    const r = await one<any>(pool, `INSERT INTO inspiration_templates(title, category, mode, cover_asset_id, prompt, tags, ratios, quality, sort, enabled,
        scene_prompt, allow_text, fields, purpose, descr, featured, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [b.title, b.category, b.mode, b.coverAssetId, b.prompt, JSON.stringify(b.tags), JSON.stringify(b.ratios), b.quality, b.sort, b.enabled,
        b.scenePrompt, b.allowText, JSON.stringify(b.fields), b.purpose, b.descr, b.featured, b.source]);
    await log(req, 'template.create', r.id, { title: b.title });
    return { id: r.id };
  });

  app.patch('/api/admin/templates/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = templatePatch.parse(req.body);
    if (b.coverAssetId) await assertCover(b.coverAssetId);
    const r = await pool.query(`UPDATE inspiration_templates SET
        title=COALESCE($2,title), category=COALESCE($3,category), mode=COALESCE($4,mode), cover_asset_id=COALESCE($5,cover_asset_id),
        prompt=COALESCE($6,prompt), tags=COALESCE($7,tags), ratios=COALESCE($8,ratios), quality=COALESCE($9,quality),
        sort=COALESCE($10,sort), enabled=COALESCE($11,enabled), scene_prompt=COALESCE($12,scene_prompt), allow_text=COALESCE($13,allow_text),
        fields=COALESCE($14,fields), purpose=COALESCE($15,purpose), descr=COALESCE($16,descr), featured=COALESCE($17,featured), source=COALESCE($18,source),
        updated_at=now() WHERE id=$1`,
      [id, b.title ?? null, b.category ?? null, b.mode ?? null, b.coverAssetId ?? null, b.prompt ?? null,
        b.tags ? JSON.stringify(b.tags) : null, b.ratios ? JSON.stringify(b.ratios) : null, b.quality ?? null, b.sort ?? null, b.enabled ?? null,
        b.scenePrompt ?? null, b.allowText ?? null, b.fields ? JSON.stringify(b.fields) : null, b.purpose ?? null, b.descr ?? null, b.featured ?? null, b.source ?? null]);
    if (!r.rowCount) throw notFound();
    await log(req, 'template.update', id, { fields: Object.keys(b) });
    return { ok: true };
  });

  app.delete('/api/admin/templates/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await pool.query('DELETE FROM inspiration_templates WHERE id=$1', [id]);
    if (!r.rowCount) throw notFound();
    await log(req, 'template.delete', id);
    return { ok: true };
  });
}

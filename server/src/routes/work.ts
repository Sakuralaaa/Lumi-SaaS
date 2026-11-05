import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, one, many, tx } from '../db/pool.js';
import { requireUser } from '../auth.js';
import { bad, HttpError, notFound } from '../lib/errors.js';
import { sanitizeUpload, thumbnail, BadImage } from '../lib/images.js';
import { getObject, putObject, signedUrl, thumbKey } from '../lib/storage.js';
import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { shanghaiDayStart } from '../lib/time.js';
import { getPrices } from '../services/pricing.js';
import { loadRules, matchRule, planBatch } from '../services/routing.js';
import { changeCredits } from '../services/credits.js';
import { mattingAvailable } from '../services/matting.js';
import { designSchema } from './design.js';
import { EDIT_OPS, LANGS, PRODUCT_ROLES, TAGS, isTextTag, renderTemplateScene, type Brand } from '../services/prompt.js';
import { assistAvailable, assistProduct, translateFacts, PlannerError } from '../services/planner.js';
import { redis } from '../queue.js';
import { sceneForShot } from '../services/templates/scenes.js';
import { cleanSlot, promoTextViolation } from '../lib/textPolicy.js';
import { genQueue } from '../queue.js';

const uuid = z.string().uuid();
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
const ROLES = ['product', 'top', 'bottom', 'shoes', 'bag', 'accessory', 'model', 'style', 'clone'] as const;
const LOCK_FALLBACK = 'Match the locked style reference image exactly: same lighting direction and softness, colour palette, colour temperature, backdrop and surfaces, and overall mood.';

/** Selling points / product name / template text: printable text must not carry URLs, contacts or invite codes. */
function checkPrintable(label: string, v: string) {
  const bad_ = promoTextViolation(v);
  if (bad_) throw bad(`${label}里不能出现${bad_}`, 'promo_text');
}

/** JSON with sorted object keys, so equal bodies hash equally regardless of key order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

async function ownProject(userId: string, id: string) {
  const p = await one<any>(pool, 'SELECT * FROM projects WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!p) throw notFound();
  return p;
}

const RETENTION_MS = config.RETENTION_DAYS * 86400_000;
/** When an asset's files will be deleted by the retention cron (ISO), or null. */
export const expiresAt = (createdAt: Date | string | null | undefined) =>
  createdAt ? new Date(new Date(createdAt).getTime() + RETENTION_MS).toISOString() : null;

async function itemView(r: any) {
  // Rows must select a.storage_key, a.created_at AS asset_created_at, a.purged_at from the output asset.
  const expired = !!r.purged_at;
  const key: string | null = expired ? null : r.storage_key ?? null;
  return {
    id: r.id, jobId: r.job_id, idx: r.idx, ratio: r.ratio, status: r.status, favorite: r.favorite,
    quality: r.used_quality, error: r.status === 'failed' ? (r.error_code === 'content_blocked' ? '描述内容不符合平台规范，积分已退回' : '生成失败，积分已退回') : null,
    width: r.width ?? null, height: r.height ?? null,
    url: key ? await signedUrl(key) : null,
    thumb: key ? await signedUrl(thumbKey(key)) : null,
    expired, expiresAt: r.storage_key ? expiresAt(r.asset_created_at) : null,
    qc: r.qc ? { pass: !!r.qc.pass, retried: !!r.qc.retried, issues: Array.isArray(r.qc.issues) ? r.qc.issues.slice(0, 6) : [], fidelity: !!r.qc.fidelity } : null,
    layered: !!r.design,
  };
}

const brandSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  font: z.enum(['sans', 'serif', 'bold']).nullable().optional(),
  lang: z.string().refine((v) => v in LANGS).nullable().optional(),
  note: z.string().trim().max(60).nullable().optional(),
});

/** Closest supported ratio for an image size (tools on uploaded photos). */
function nearestRatio(w: number, h: number): string {
  const r = w / Math.max(1, h);
  let best = '1:1'; let d = Infinity;
  for (const x of RATIOS) { const [a, b] = x.split(':').map(Number); const dd = Math.abs(Math.log(r / (a / b))); if (dd < d) { d = dd; best = x; } }
  return best;
}

export default async function workRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { if (req.url.startsWith('/api/')) await requireUser(req); });

  // ---------- options shown to the client (no model names) ----------
  app.get('/api/options', async () => {
    const prices = await getPrices();
    const s = await getSettings();
    return { prices, ratios: RATIOS, tags: Object.keys(TAGS), maxImagesPerJob: s.max_images_per_job };
  });

  // ---------- projects ----------
  app.get('/api/projects', async (req) => {
    const rows = await many(pool, `
      SELECT p.id, p.name, p.mode, p.created_at, p.updated_at, p.style_lock, p.brand, a.storage_key AS cover_key, la.storage_key AS lock_key
        FROM projects p LEFT JOIN assets a ON a.id = p.cover_asset_id AND a.user_id = p.user_id AND a.purged_at IS NULL
        LEFT JOIN assets la ON la.id = (p.style_lock->>'assetId')::uuid AND la.user_id = p.user_id AND la.purged_at IS NULL
       WHERE p.user_id=$1 AND NOT p.tools ORDER BY p.updated_at DESC LIMIT 200`, [req.user!.id]);
    return Promise.all(rows.map(async (r: any) => ({
      id: r.id, name: r.name, mode: r.mode, createdAt: r.created_at, updatedAt: r.updated_at, brand: r.brand ?? null,
      cover: r.cover_key ? await signedUrl(r.cover_key.replace(/^outputs\//, 'thumbs/').replace(/\.(png|jpg)$/, '.webp')) : null,
      styleLock: r.style_lock ? { jobId: r.style_lock.jobId ?? null, assetId: r.style_lock.assetId ?? null, thumb: r.lock_key ? await signedUrl(thumbKey(r.lock_key)) : null } : null,
    })));
  });

  app.post('/api/projects', async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).default('未命名项目'), mode: z.enum(['simple', 'detailed']) }).parse(req.body);
    return one(pool, 'INSERT INTO projects(user_id, name, mode) VALUES ($1,$2,$3) RETURNING id, name, mode, created_at', [req.user!.id, b.name, b.mode]);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), mode: z.enum(['simple', 'detailed']).optional(), brand: brandSchema.nullable().optional() }).parse(req.body);
    await ownProject(req.user!.id, id);
    let brand: Brand | null | undefined;
    if (b.brand !== undefined) {
      brand = b.brand ? { color: b.brand.color ?? null, font: b.brand.font ?? null, lang: b.brand.lang ?? null, note: b.brand.note ? cleanSlot(b.brand.note, 60) : null } : null;
      if (brand?.note) checkPrintable('品牌描述', brand.note);
      if (brand && !brand.color && !brand.font && (!brand.lang || brand.lang === 'zh') && !brand.note) brand = null;
    }
    await pool.query(`UPDATE projects SET name=COALESCE($3,name), mode=COALESCE($4,mode), brand=CASE WHEN $5 THEN $6::jsonb ELSE brand END, updated_at=now()
      WHERE id=$1 AND user_id=$2`, [id, req.user!.id, b.name ?? null, b.mode ?? null, brand !== undefined, brand ? JSON.stringify(brand) : null]);
    return { ok: true, brand: brand === undefined ? undefined : brand };
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await pool.query(`DELETE FROM projects WHERE id=$1 AND user_id=$2
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE project_id=$1 AND status IN ('queued','running'))`, [id, req.user!.id]);
    if (!r.rowCount) throw bad('项目不存在或仍有任务在生成');
    return { ok: true };
  });

  // ---------- uploads ----------
  app.post('/api/uploads', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const file = await req.file({ limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 } });
    if (!file) throw bad('没有收到文件');
    const buf = await file.toBuffer().catch(() => { throw bad('文件过大，最大 15MB'); });
    if (file.file.truncated) throw bad('文件过大，最大 15MB');
    let img;
    try { img = await sanitizeUpload(buf); } catch (e) { throw bad(e instanceof BadImage ? e.message : '无法处理该图片'); }
    const id = randomUUID();
    const key = `uploads/${req.user!.id}/${id}.${img.ext}`;
    await putObject(key, img.data, img.mime);
    await putObject(`thumbs/${req.user!.id}/${id}.webp`, await thumbnail(img.data), 'image/webp');
    await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256)
                      VALUES ($1,$2,'upload',$3,$4,$5,$6,$7,$8)`, [id, req.user!.id, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
    return { id, width: img.width, height: img.height, thumb: await signedUrl(`thumbs/${req.user!.id}/${id}.webp`), url: await signedUrl(key) };
  });

  // ---------- jobs ----------
  interface NewJob {
    userId: string; project: any; kind: 'generate' | 'retry' | 'edit'; quality: 'standard' | 'hd'; prompt: string; tags: string[];
    ratios: string[]; perRatio: number; inputs: { assetId: string; role: string }[]; ratioSeq?: string[] | null; brand?: Brand | null;
    tpl?: { id: string | null; scene: string; allowText: boolean; fields: Record<string, string> } | null;
    facts?: { name?: string; points?: string[] } | null; shots?: { tag: string | null; text: string }[] | null; styleLock?: string | null;
    parentItemId?: string | null; editOp?: string | null; editText?: string | null; plan?: unknown;
    idem?: { key: string; hash: string; replay: (row: any) => any } | null;
  }

  /** Reserve credits and insert job + inputs + items in one transaction; then enqueue. Shared by create / retry / edit. */
  async function createJobRecord(n: NewJob) {
    const seq = n.ratioSeq?.length ? n.ratioSeq : n.ratios.flatMap((r) => Array.from({ length: n.perRatio }, () => r));
    const total = seq.length;
    const s = await getSettings();
    if (total > s.max_images_per_job) throw bad(`每次最多生成 ${s.max_images_per_job} 张`);
    const rule = matchRule(await loadRules(), { quality: n.quality, refs: n.inputs.length, tags: n.tags });
    if (!rule) throw new HttpError(503, 'no_route', '服务暂不可用，请稍后再试');
    const prices = await getPrices();
    const unit = prices[n.quality];
    const cost = unit * total;
    const canMix = n.kind === 'generate' && n.quality === 'standard' && n.inputs.length <= 3;
    const userId = n.userId;

    const job = await tx(async (c) => {
      if (n.idem) {
        // Claim the key inside the reserve transaction. A concurrent duplicate blocks on the PK until we
        // commit (then replays) or roll back (then it proceeds itself) — credits can never be reserved twice.
        await c.query(`DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2 AND created_at <= now() - interval '24 hours'`, [userId, n.idem.key]);
        const claimed = await c.query(`INSERT INTO idempotency_keys(user_id, key, request_hash) VALUES ($1,$2,$3)
          ON CONFLICT (user_id, key) DO NOTHING`, [userId, n.idem.key, n.idem.hash]);
        if (!claimed.rowCount) {
          const prev = await one<any>(c, 'SELECT request_hash, response FROM idempotency_keys WHERE user_id=$1 AND key=$2', [userId, n.idem.key]);
          return { replayed: n.idem.replay(prev) };
        }
      }
      const u = await one<any>(c, 'SELECT credits, daily_limit FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const limit = u.daily_limit ?? s.beta_daily_image_limit;
      const used = await one<any>(c, `SELECT count(*)::int AS n FROM job_items WHERE user_id=$1 AND created_at >= $2 AND status <> 'failed'`, [userId, shanghaiDayStart()]);
      if (used.n + total > limit) throw new HttpError(429, 'daily_limit', `今天还能生成 ${Math.max(0, limit - used.n)} 张`);
      if (u.credits < cost) throw new HttpError(402, 'insufficient_credits', '积分不足');
      const j = await one<any>(c, `INSERT INTO jobs(user_id, project_id, mode, quality, prompt, tags, ratios, per_ratio, reserved_credits, unit_price_standard, unit_price_hd,
           template_id, template_fields, template_scene, template_text, kind, facts, shots, style_lock, parent_item_id, edit_op, edit_text, plan, brand)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id, created_at`,
        [userId, n.project.id, n.project.mode, n.quality, n.prompt, JSON.stringify(n.tags), JSON.stringify([...new Set(seq)]), n.ratioSeq?.length ? 1 : n.perRatio, cost, prices.standard, prices.hd,
          n.tpl?.id ?? null, n.tpl ? JSON.stringify(n.tpl.fields) : null, n.tpl?.scene ?? null, n.tpl?.allowText ?? false,
          n.kind, n.facts ? JSON.stringify(n.facts) : null, n.shots ? JSON.stringify(n.shots) : null, n.styleLock ?? null,
          n.parentItemId ?? null, n.editOp ?? null, n.editText ?? null, n.plan ? JSON.stringify(n.plan) : null, n.brand ? JSON.stringify(n.brand) : null]);
      if (n.tpl?.id && n.kind === 'generate') await c.query('UPDATE inspiration_templates SET uses = uses + 1 WHERE id=$1', [n.tpl.id]);
      for (const [i, inp] of n.inputs.entries()) {
        await c.query('INSERT INTO job_inputs(job_id, asset_id, role, position) VALUES ($1,$2,$3,$4)', [j.id, inp.assetId, inp.role, i]);
      }
      const plan = planBatch(rule, total, s.mix_batch_enabled, canMix);
      for (const [idx, ratio] of seq.entries()) {
        await c.query('INSERT INTO job_items(job_id, user_id, idx, ratio, planned_model, credits) VALUES ($1,$2,$3,$4,$5,$6)',
          [j.id, userId, idx, ratio, plan[idx], unit]);
      }
      await changeCredits(c, { userId, delta: -cost, reason: 'reserve', jobId: j.id });
      await c.query('UPDATE projects SET updated_at=now() WHERE id=$1', [n.project.id]);
      if (n.idem) {
        const ids = await many<any>(c, 'SELECT id FROM job_items WHERE job_id=$1 ORDER BY idx', [j.id]);
        await c.query('UPDATE idempotency_keys SET job_id=$3, response=$4 WHERE user_id=$1 AND key=$2',
          [userId, n.idem.key, j.id, JSON.stringify({ id: j.id, items: ids.map((i) => i.id), reserved: cost })]);
      }
      return j;
    });
    if ('replayed' in job) return job.replayed as { id: string; items: string[]; reserved: number };
    const items = await many<any>(pool, 'SELECT id FROM job_items WHERE job_id=$1 ORDER BY idx', [job.id]);
    await genQueue.addBulk(items.map((it) => ({ name: 'item', data: { itemId: it.id, userId, primaryModel: rule.primary_model, fallbackModel: rule.fallback_model }, opts: { jobId: it.id } })));
    return { id: job.id as string, items: items.map((i) => i.id as string), reserved: cost };
  }

  /** All assets must belong to the user and still exist. */
  async function assertOwnedAssets(userId: string, ids: string[]) {
    if (!ids.length) return;
    const owned = await many<any>(pool, 'SELECT id, purged_at FROM assets WHERE id = ANY($1::uuid[]) AND user_id=$2', [ids, userId]);
    if (owned.length !== new Set(ids).size) throw notFound();
    if (owned.some((a) => a.purged_at)) throw new HttpError(410, 'asset_expired', '有图片已超过保存期限被删除，请重新上传');
  }

  const factsSchema = z.object({
    name: z.string().trim().max(30).default(''),
    points: z.array(z.string().trim().max(24)).max(5).default([]),
  });
  const shotSchema = z.object({ tag: z.string().max(30).nullable().default(null), text: z.string().trim().max(120).default('') });

  const createJob = z.object({
    projectId: uuid,
    prompt: z.string().trim().max(500).default(''),
    tags: z.array(z.string().max(30)).max(6).default([]),
    quality: z.enum(['standard', 'hd']).default('standard'),
    ratios: z.array(z.enum(RATIOS)).min(1).max(4).optional(),
    perRatio: z.number().int().min(1).max(4).optional(),
    // storyboard rows: one per image with its own type and ratio (replaces ratios × perRatio)
    rows: z.array(z.object({ ratio: z.enum(RATIOS), tag: z.string().max(30).nullable().default(null), text: z.string().trim().max(120).default('') })).min(1).max(16).optional(),
    inputs: z.array(z.object({ assetId: uuid, role: z.enum(ROLES) })).max(5).default([]),
    templateId: uuid.optional(),
    templateFields: z.partialRecord(z.enum(['brand', 'headline', 'sub', 'points']), z.string().trim().max(40)).optional(),
    facts: factsSchema.optional(),
    shots: z.array(shotSchema).max(16).optional(),
    useStyleLock: z.boolean().default(true),
  });

  app.post('/api/jobs', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = createJob.parse(req.body);
    const userId = req.user!.id;
    // Idempotency-Key (optional UUID): same key within 24h replays the original response, never charges twice.
    const rawKey = req.headers['idempotency-key'];
    const idemKey = typeof rawKey === 'string' && rawKey ? rawKey.trim().toLowerCase() : null;
    if (idemKey !== null && !uuid.safeParse(idemKey).success) throw bad('Idempotency-Key 必须是 UUID', 'bad_idempotency_key');
    const reqHash = sha256(stableJson(b));
    const replay = (row: any) => {
      if (row.request_hash !== reqHash) throw new HttpError(409, 'idempotency_conflict', '同一个请求标识被用于不同的内容，请刷新后重试');
      if (!row.response) throw new HttpError(409, 'idempotency_in_progress', '请求正在处理中');
      reply.header('Idempotent-Replayed', 'true');
      return row.response as { id: string; items: string[]; reserved: number };
    };
    if (idemKey) {
      const prev = await one<any>(pool, `SELECT request_hash, response FROM idempotency_keys
        WHERE user_id=$1 AND key=$2 AND created_at > now() - interval '24 hours'`, [userId, idemKey]);
      if (prev) return replay(prev);
    }
    if (!b.rows && !(b.ratios?.length && b.perRatio)) throw bad('请选择要生成的图片');
    const rows = b.rows?.map((r) => ({ ratio: r.ratio, tag: r.tag && r.tag in TAGS ? r.tag : null, text: r.text }));
    const tags = rows ? [...new Set(rows.map((r) => r.tag).filter((t): t is string => !!t))] : [...new Set(b.tags.filter((t) => t in TAGS))];
    const ratios = rows ? [...new Set(rows.map((r) => r.ratio))] : [...new Set(b.ratios!)];
    const perRatio = rows ? 1 : b.perRatio!;
    const ratioSeq = rows ? rows.map((r) => r.ratio) : null;
    const total = rows ? rows.length : ratios.length * perRatio;
    let tpl: NewJob['tpl'] = null;
    if (b.templateId) {
      const t = await one<any>(pool, 'SELECT id, scene_prompt, allow_text, fields FROM inspiration_templates WHERE id=$1 AND enabled', [b.templateId]);
      if (!t) throw new HttpError(410, 'template_gone', '这个模板已下线，请换一个');
      if (t.scene_prompt) {
        const allowed = new Map<string, number>((Array.isArray(t.fields) ? t.fields : []).map((f: any) => [String(f.key), Number(f.max) || 20]));
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(b.templateFields ?? {})) {
          const max = allowed.get(k);
          if (max && v) { checkPrintable('图上的文字', v); fields[k] = v.slice(0, max); }
        }
        tpl = { id: t.id, scene: renderTemplateScene(t.scene_prompt, fields), allowText: !!t.allow_text, fields };
      }
      if (!b.inputs.some((i) => PRODUCT_ROLES.includes(i.role)) && t.scene_prompt) throw bad('做同款需要先上传你的商品图');
    }
    if (!b.prompt && !tags.length && !b.inputs.length) throw bad('请上传商品图或写一句描述');
    const project = await ownProject(userId, b.projectId);

    // Product facts: printable on selling-point images, so policy-checked.
    let facts: NewJob['facts'] = null;
    if (b.facts) {
      const name = cleanSlot(b.facts.name, 30);
      const points = b.facts.points.map((p) => cleanSlot(p, 24)).filter(Boolean).slice(0, 5);
      if (name) checkPrintable('商品名称', name);
      for (const p of points) checkPrintable('卖点', p);
      if (name || points.length) facts = { name, points };
    }
    // Storyboard: one shot per item (the user may have edited each line).
    let shots: NewJob['shots'] = null;
    if (rows && !tpl) {
      shots = rows.map((x) => ({ tag: x.tag, text: cleanSlot(x.text, 120) }));
    } else if (b.shots?.length && !tpl) {
      if (b.shots.length !== total) throw bad('分镜数量和生成张数不一致，请刷新后重试');
      shots = b.shots.map((x) => ({ tag: x.tag && x.tag in TAGS ? x.tag : null, text: cleanSlot(x.text, 120) }));
    }
    // Brand snapshot; text images in another language get a translated copy of the facts (original kept for QC/history).
    const brand: Brand | null = !tpl && project.brand ? project.brand : null;
    if (facts && brand?.lang && brand.lang !== 'zh' && (shots ?? []).some((x) => isTextTag(x.tag))) {
      const tr = await translateFacts(facts, LANGS[brand.lang].en);
      if (tr && !promoTextViolation([tr.name, ...tr.points].join(' '))) facts = { ...facts, printed: tr } as any;
    }

    const inputs: { assetId: string; role: string }[] = [...b.inputs];
    const assetIds = [...new Set(inputs.map((i) => i.assetId))];
    if (assetIds.length !== inputs.length) throw bad('同一张图不能重复使用');
    await assertOwnedAssets(userId, assetIds);

    // Style lock: snapshot the project's locked look; its image rides along as the style reference when there is room.
    let styleLock: string | null = null;
    if (b.useStyleLock && project.style_lock && !tpl) {
      styleLock = String(project.style_lock.text || LOCK_FALLBACK).slice(0, 700);
      const lockAsset = project.style_lock.assetId as string | undefined;
      if (lockAsset && !inputs.some((i) => i.role === 'style' || i.role === 'clone') && inputs.length < 5 && !assetIds.includes(lockAsset)) {
        const a = await one<any>(pool, 'SELECT id FROM assets WHERE id=$1 AND user_id=$2 AND purged_at IS NULL', [lockAsset, userId]);
        if (a) inputs.push({ assetId: a.id, role: 'style' });
      }
    }

    return createJobRecord({ userId, project, kind: 'generate', quality: b.quality, prompt: b.prompt, tags, ratios, perRatio, ratioSeq, inputs,
      tpl, facts, shots, styleLock, brand, idem: idemKey ? { key: idemKey, hash: reqHash, replay } : null });
  });

  // ---------- single-image retry / one-line edit & edit tools ----------
  async function parentOf(userId: string, itemId: string) {
    const it = await one<any>(pool, `SELECT i.*, a.storage_key, a.purged_at FROM job_items i LEFT JOIN assets a ON a.id=i.output_asset_id
      WHERE i.id=$1 AND i.user_id=$2 AND NOT i.deleted`, [itemId, userId]);
    if (!it) throw notFound();
    const job = await one<any>(pool, 'SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [it.job_id, userId]);
    if (!job) throw notFound();
    const inputs = await many<any>(pool, `SELECT ji.role, ji.asset_id, a.purged_at FROM job_inputs ji JOIN assets a ON a.id=ji.asset_id
      WHERE ji.job_id=$1 AND a.user_id=$2 ORDER BY ji.position`, [job.id, userId]);
    const project = await ownProject(userId, job.project_id);
    return { it, job, inputs, project };
  }

  app.post('/api/items/:id/retry', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const userId = req.user!.id;
    const { it, job, inputs, project } = await parentOf(userId, id);
    if (inputs.some((x) => x.purged_at)) throw new HttpError(410, 'asset_expired', '这张图用到的图片已超过保存期限，请重新上传后生成');
    if (job.plan?.status === 'blocked') throw bad('这一批的描述不符合平台规范，无法重试');
    // Re-use the same plan / shot / template for this one image so only the randomness changes.
    let plan: any = null;
    if (job.plan?.status === 'ok') {
      const p = job.plan.plan;
      const mine = (p.items ?? []).filter((x: any) => x.index === it.idx).map((x: any) => ({ ...x, index: 0 }));
      if (mine.length) plan = { ...job.plan, plan: { ...p, items: mine } };
    }
    const shot = Array.isArray(job.shots) ? job.shots[it.idx] : null;
    const tag = sceneForShot(job.tags ?? [], it.idx, job.shots).tag;
    const shots = job.template_scene ? null : [{ tag: shot?.tag ?? tag ?? null, text: shot?.text ?? '' }];
    const r = await createJobRecord({
      userId, project, kind: job.kind === 'edit' ? 'edit' : 'retry', quality: job.quality, prompt: job.prompt, tags: job.tags ?? [],
      ratios: [it.ratio], perRatio: 1, inputs: inputs.map((x) => ({ assetId: x.asset_id, role: x.role })),
      tpl: job.template_scene ? { id: job.template_id, scene: job.template_scene, allowText: job.template_text, fields: job.template_fields ?? {} } : null,
      facts: job.facts, shots, styleLock: job.style_lock, parentItemId: it.id, editOp: job.edit_op, editText: job.edit_text, plan, brand: job.brand,
    });
    await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [it.id, userId, 'retry']);
    return r;
  });

  const editBody = z.object({
    op: z.enum(EDIT_OPS).default('free'),
    text: z.string().trim().max(200).default(''),
    ratio: z.enum(RATIOS).optional(),
    baseAssetId: uuid.optional(), // erase: the photo with the user's red brush strokes, uploaded by the client
    modelAssetId: uuid.optional(), // swap_model: the new model's portrait (from the model library)
    lang: z.string().refine((v) => v in LANGS).optional(), // translate
  });

  /** Shared validation + record creation for an edit of one image (an item's output, or a 工具箱 upload). */
  async function spawnEdit(userId: string, project: any, b: z.infer<typeof editBody>, src: { assetId: string; ratio: string; quality: 'standard' | 'hd'; parentItemId: string | null; products: { assetId: string; role: string }[] }) {
    if (b.op === 'text') throw bad('加文字请使用文字编辑器');
    if (b.op === 'matte' && !mattingAvailable()) throw bad('透明底抠图暂不可用');
    if ((b.op === 'free' || b.op === 'recolor') && b.text.length < 2) throw bad('请写一句想怎么改');
    if (b.op === 'erase' && !b.baseAssetId) throw bad('请先涂抹要消除的地方');
    if (b.op === 'expand' && (!b.ratio || b.ratio === src.ratio)) throw bad('请选择一个不同的比例来扩图');
    if (b.op === 'swap_model' && !b.modelAssetId) throw bad('请选择要换上的模特');
    if (b.op === 'translate' && (!b.lang || b.lang === 'zh')) throw bad('请选择要翻译成的语言');
    const base = b.baseAssetId ?? src.assetId;
    const extra = [b.baseAssetId, b.modelAssetId].filter((x): x is string => !!x);
    if (extra.length) await assertOwnedAssets(userId, extra);
    const products = src.products.filter((x) => x.assetId !== base).slice(0, b.op === 'swap_model' ? 1 : 2);
    const inputs = [{ assetId: base, role: 'base' }, ...(b.op === 'swap_model' ? [{ assetId: b.modelAssetId!, role: 'model' }] : []), ...products];
    const text = b.op === 'translate' ? LANGS[b.lang!].en : cleanSlot(b.text, 200);
    return createJobRecord({
      userId, project, kind: 'edit', quality: b.op === 'upscale' ? 'hd' : src.quality, prompt: '', tags: [],
      ratios: [b.op === 'expand' ? b.ratio! : src.ratio], perRatio: 1, inputs,
      parentItemId: src.parentItemId, editOp: b.op, editText: text,
    });
  }

  const productInputs = (inputs: any[]) => inputs.filter((x) => PRODUCT_ROLES.includes(x.role) && !x.purged_at).map((x) => ({ assetId: x.asset_id as string, role: 'product' }));

  app.post('/api/items/:id/edit', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = editBody.parse(req.body);
    const userId = req.user!.id;
    const { it, job, inputs, project } = await parentOf(userId, id);
    if (it.status !== 'succeeded' || !it.output_asset_id) throw bad('只能修改已生成成功的图片');
    if (it.purged_at) throw new HttpError(410, 'expired', `图片已超过 ${config.RETENTION_DAYS} 天保存期限，已被删除`);
    // Original product photos keep the product faithful through edits (still-present only).
    const r = await spawnEdit(userId, project, b, { assetId: it.output_asset_id, ratio: it.ratio, quality: job.quality, parentItemId: it.id, products: productInputs(inputs) });
    await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [it.id, userId, 'edit']);
    return r;
  });

  // ---------- whole-batch edit: translate / recolor / one-line change applied to every image of a batch ----------
  app.post('/api/jobs/:id/edit-all', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = editBody.extend({ itemIds: z.array(uuid).min(1).max(16).optional() }).parse(req.body);
    if (!['translate', 'recolor', 'free', 'upscale', 'cutout', 'matte'].includes(b.op)) throw bad('这个修改只能一张一张做');
    const userId = req.user!.id;
    const job = await one<any>(pool, 'SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [id, userId]);
    if (!job) throw notFound();
    const project = await ownProject(userId, job.project_id);
    // itemIds: the versions the user is looking at (latest edit of each image); default = the batch's own images
    const items = await many<any>(pool, `SELECT i.id, i.ratio, i.output_asset_id FROM job_items i JOIN assets a ON a.id=i.output_asset_id
      WHERE ${b.itemIds ? 'i.id = ANY($1::uuid[])' : 'i.job_id=$1'} AND i.user_id=$2 AND i.status='succeeded' AND NOT i.deleted AND a.purged_at IS NULL ORDER BY i.created_at, i.idx`,
      [b.itemIds ?? id, userId]);
    if (!items.length) throw bad('这一批没有可修改的图片');
    const inputs = await many<any>(pool, `SELECT ji.role, ji.asset_id, a.purged_at FROM job_inputs ji JOIN assets a ON a.id=ji.asset_id
      WHERE ji.job_id=$1 AND a.user_id=$2 ORDER BY ji.position`, [id, userId]);
    const prices = await getPrices();
    const need = prices[b.op === 'upscale' ? 'hd' : job.quality as 'standard' | 'hd'] * items.length;
    const me = await one<any>(pool, 'SELECT credits FROM users WHERE id=$1', [userId]);
    if (me.credits < need) throw new HttpError(402, 'insufficient_credits', `积分不足，这一批需要 ${need} 积分`);
    let reserved = 0; const ids: string[] = [];
    for (const it of items) {
      const r = await spawnEdit(userId, project, { ...b, baseAssetId: undefined, modelAssetId: undefined }, { assetId: it.output_asset_id, ratio: it.ratio, quality: job.quality, parentItemId: it.id, products: productInputs(inputs) });
      reserved += r.reserved; ids.push(r.id);
      await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [it.id, userId, 'edit']);
    }
    return { jobs: ids, reserved };
  });

  // ---------- text editor: the client composes text onto the image and uploads the result (free, no model call) ----------
  app.post('/api/items/:id/overlay', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ assetId: uuid, texts: z.array(z.string().trim().max(60)).max(40).default([]), design: designSchema.optional() }).parse(req.body);
    const userId = req.user!.id;
    const { it, job, inputs, project } = await parentOf(userId, id);
    if (it.status !== 'succeeded') throw bad('只能编辑生成成功的图片');
    const texts = b.design ? b.design.layers.filter((l) => l.type === 'text' && !l.hidden).map((l: any) => String(l.text).trim()).filter(Boolean) : b.texts;
    for (const t of texts) checkPrintable('图上的文字', t);
    if (!b.design && !texts.length) throw bad('先加一段文字');
    // Editing a design version again: same base and same parent, so versions stay grouped and layers stay editable.
    const again = it.planned_model === 'overlay' && it.design;
    const baseAsset = again ? (inputs.find((x) => x.role === 'base')?.asset_id ?? it.output_asset_id) : it.output_asset_id;
    const parentItem = again && job.parent_item_id ? job.parent_item_id : it.id;
    if (b.design) {
      const ids = [...new Set(b.design.layers.filter((l) => l.type === 'image').map((l: any) => l.assetId as string))];
      if (ids.length) {
        const n = await one<any>(pool, 'SELECT count(*)::int AS n FROM assets WHERE id = ANY($1) AND user_id=$2 AND purged_at IS NULL', [ids, userId]);
        if (n.n !== ids.length) throw notFound();
      }
    }
    const a = await one<any>(pool, `SELECT id, kind FROM assets WHERE id=$1 AND user_id=$2 AND purged_at IS NULL`, [b.assetId, userId]);
    if (!a || a.kind !== 'upload') throw notFound();
    const r = await tx(async (c) => {
      const j = await one<any>(c, `INSERT INTO jobs(user_id, project_id, mode, quality, prompt, tags, ratios, per_ratio, reserved_credits, unit_price_standard, unit_price_hd,
          kind, parent_item_id, edit_op, edit_text, status, finished_at)
        VALUES ($1,$2,$3,$4,'','[]',$5,1,0,0,0,'edit',$6,'text',$7,'done',now()) RETURNING id`,
        [userId, project.id, project.mode, job.quality, JSON.stringify([it.ratio]), parentItem, (texts.join(' / ') || '图层编辑').slice(0, 200)]);
      await c.query('INSERT INTO job_inputs(job_id, asset_id, role, position) VALUES ($1,$2,$3,0)', [j.id, baseAsset, 'base']);
      // the composite becomes an output asset (same retention as generated images)
      await c.query(`UPDATE assets SET kind='output', project_id=$3 WHERE id=$1 AND user_id=$2`, [a.id, userId, project.id]);
      const item = await one<any>(c, `INSERT INTO job_items(job_id, user_id, idx, ratio, planned_model, credits, status, output_asset_id, used_quality, finished_at, design)
        VALUES ($1,$2,0,$3,'overlay',0,'succeeded',$4,$5,now(),$6) RETURNING id`, [j.id, userId, it.ratio, a.id, job.quality, b.design ? JSON.stringify(b.design) : null]);
      await c.query('UPDATE projects SET updated_at=now() WHERE id=$1', [project.id]);
      return { id: j.id as string, items: [item.id as string], reserved: 0 };
    });
    await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [it.id, userId, 'overlay']);
    return r;
  });

  // ---------- 工具箱: edit tools on any uploaded photo (kept in a hidden per-user project) ----------
  async function toolsProject(userId: string) {
    const p = await one<any>(pool, 'SELECT * FROM projects WHERE user_id=$1 AND tools', [userId]);
    if (p) return p;
    await pool.query(`INSERT INTO projects(user_id, name, mode, tools) VALUES ($1,'工具箱','simple',true) ON CONFLICT DO NOTHING`, [userId]);
    return one<any>(pool, 'SELECT * FROM projects WHERE user_id=$1 AND tools', [userId]);
  }
  app.get('/api/tools', async (req) => ({ projectId: (await toolsProject(req.user!.id)).id }));
  app.post('/api/tools/edit', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = editBody.extend({ assetId: uuid, quality: z.enum(['standard', 'hd']).default('standard') }).parse(req.body);
    const userId = req.user!.id;
    const a = await one<any>(pool, 'SELECT id, width, height, purged_at FROM assets WHERE id=$1 AND user_id=$2', [b.assetId, userId]);
    if (!a) throw notFound();
    if (a.purged_at) throw new HttpError(410, 'asset_expired', '图片已超过保存期限被删除，请重新上传');
    const project = await toolsProject(userId);
    return spawnEdit(userId, project, b, { assetId: a.id, ratio: nearestRatio(a.width, a.height), quality: b.quality, parentItemId: null, products: [] });
  });

  // ---------- AI assistant: product name, selling points and a storyboard draft from the photos (free, rate-limited) ----------
  app.post('/api/assist/product', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({
      assetIds: z.array(uuid).min(1).max(3),
      rows: z.array(z.object({ tag: z.string().max(30).nullable(), ratio: z.enum(RATIOS) })).max(16).default([]),
      facts: z.object({ name: z.string().max(30).default(''), points: z.array(z.string().max(24)).max(5).default([]) }).optional(),
      mode: z.enum(['simple', 'detailed']).default('simple'),
    }).parse(req.body);
    const userId = req.user!.id;
    if (!(await assistAvailable())) throw new HttpError(503, 'assist_off', 'AI 助手暂时不可用，可以自己填写');
    const dayKey = `assist:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const n = await redis.incr(dayKey); if (n === 1) await redis.expire(dayKey, 90_000);
    if (n > 200) throw new HttpError(429, 'assist_limit', '今天 AI 帮写的次数用完了，明天再来');
    await assertOwnedAssets(userId, b.assetIds);
    const assets = await many<any>(pool, 'SELECT storage_key FROM assets WHERE id = ANY($1::uuid[]) AND user_id=$2', [b.assetIds, userId]);
    const images = await Promise.all(assets.map((x) => getObject(x.storage_key)));
    const rows = b.rows.map((r) => ({ tag: r.tag && r.tag in TAGS ? r.tag : null, ratio: r.ratio }));
    let out;
    try { out = await assistProduct(images, rows, b.facts ?? null, b.mode); }
    catch (e) { if (e instanceof PlannerError) throw new HttpError(502, 'assist_failed', 'AI 这次没写好，再点一次试试'); throw e; }
    if (!out) throw new HttpError(503, 'assist_off', 'AI 助手暂时不可用，可以自己填写');
    // printable text is policy-checked; anything that fails is dropped rather than shown
    const okText = (t: string) => !!t && !promoTextViolation(t);
    return {
      name: okText(out.name) ? cleanSlot(out.name, 30) : '',
      points: out.points.map((p) => cleanSlot(p, 24)).filter(okText).slice(0, 5),
      shots: out.shots.map((x) => (x && !promoTextViolation(x) ? cleanSlot(x, 120) : '')),
    };
  });

  // ---------- style lock ----------
  app.post('/api/projects/:id/style-lock', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ jobId: uuid, itemId: uuid.optional() }).parse(req.body);
    const userId = req.user!.id;
    await ownProject(userId, id);
    const job = await one<any>(pool, 'SELECT id, plan, style_lock FROM jobs WHERE id=$1 AND user_id=$2 AND project_id=$3', [b.jobId, userId, id]);
    if (!job) throw notFound();
    const pick = await one<any>(pool, `SELECT i.output_asset_id FROM job_items i JOIN assets a ON a.id=i.output_asset_id
      WHERE i.job_id=$1 AND i.user_id=$2 AND i.status='succeeded' AND NOT i.deleted AND a.purged_at IS NULL ${b.itemId ? 'AND i.id=$3' : ''}
      ORDER BY i.idx LIMIT 1`, b.itemId ? [job.id, userId, b.itemId] : [job.id, userId]);
    if (!pick) throw bad('这一批还没有可用的成图');
    const text = (job.plan?.status === 'ok' && job.plan.plan?.style_lock) || job.style_lock || '';
    const lock = { text: String(text).slice(0, 700), assetId: pick.output_asset_id, jobId: job.id, at: new Date().toISOString() };
    await pool.query('UPDATE projects SET style_lock=$3, updated_at=now() WHERE id=$1 AND user_id=$2', [id, userId, JSON.stringify(lock)]);
    return { ok: true, jobId: job.id };
  });

  app.delete('/api/projects/:id/style-lock', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownProject(req.user!.id, id);
    await pool.query('UPDATE projects SET style_lock=NULL WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
    return { ok: true };
  });

  app.get('/api/projects/:id/jobs', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownProject(req.user!.id, id);
    const jobs = await many<any>(pool, `SELECT j.id, j.status, j.quality, j.prompt, j.tags, j.ratios, j.per_ratio, j.reserved_credits, j.refunded_credits, j.created_at,
        j.template_id, j.template_fields, j.kind, j.facts, j.shots, j.edit_op, j.edit_text, j.parent_item_id, j.style_lock IS NOT NULL AS locked,
        t.title AS template_title, t.fields AS template_field_defs, t.enabled AS template_enabled
      FROM jobs j LEFT JOIN inspiration_templates t ON t.id=j.template_id WHERE j.project_id=$1 AND j.user_id=$2 ORDER BY j.created_at DESC LIMIT 120`, [id, req.user!.id]);
    if (!jobs.length) return [];
    const items = await many<any>(pool, `SELECT i.*, a.storage_key, a.width, a.height, a.created_at AS asset_created_at, a.purged_at FROM job_items i
      LEFT JOIN assets a ON a.id = i.output_asset_id
      WHERE i.job_id = ANY($1::uuid[]) AND i.user_id=$2 AND NOT i.deleted ORDER BY i.idx`, [jobs.map((j) => j.id), req.user!.id]);
    const inputs = await many<any>(pool, `SELECT ji.job_id, ji.role, ji.position, a.id AS asset_id, a.storage_key, a.purged_at FROM job_inputs ji
      JOIN assets a ON a.id = ji.asset_id WHERE ji.job_id = ANY($1::uuid[]) AND a.user_id=$2 ORDER BY ji.position`, [jobs.map((j) => j.id), req.user!.id]);
    return Promise.all(jobs.map(async (j) => ({
      id: j.id, status: j.status, quality: j.quality, prompt: j.prompt, tags: j.tags, ratios: j.ratios,
      perRatio: j.per_ratio, credits: j.reserved_credits - j.refunded_credits, createdAt: j.created_at,
      kind: j.kind, facts: j.facts ?? null, shots: j.shots ?? null, editOp: j.edit_op ?? null, editText: j.edit_text ?? null,
      parentItemId: j.parent_item_id ?? null, locked: !!j.locked,
      template: j.template_id && j.template_enabled ? { id: j.template_id, title: j.template_title, fields: j.template_field_defs ?? [], values: j.template_fields ?? {} } : null,
      inputs: await Promise.all(inputs.filter((x) => x.job_id === j.id).map(async (x) => ({
        assetId: x.asset_id, role: x.role, expired: !!x.purged_at,
        thumb: x.purged_at ? null : await signedUrl(thumbKey(x.storage_key)),
      }))),
      items: await Promise.all(items.filter((i) => i.job_id === j.id).map(itemView)),
    })));
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const j = await one<any>(pool, 'SELECT id, status FROM jobs WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
    if (!j) throw notFound();
    const items = await many<any>(pool, `SELECT i.*, a.storage_key, a.width, a.height, a.created_at AS asset_created_at, a.purged_at FROM job_items i LEFT JOIN assets a ON a.id=i.output_asset_id
      WHERE i.job_id=$1 AND i.user_id=$2 AND NOT i.deleted ORDER BY i.idx`, [id, req.user!.id]);
    const me = await one<any>(pool, 'SELECT credits FROM users WHERE id=$1', [req.user!.id]);
    return { id: j.id, status: j.status, credits: me.credits, items: await Promise.all(items.map(itemView)) };
  });

  // ---------- items ----------
  async function ownItem(userId: string, id: string) {
    const it = await one<any>(pool, `SELECT i.*, a.storage_key, a.purged_at FROM job_items i LEFT JOIN assets a ON a.id=i.output_asset_id
      WHERE i.id=$1 AND i.user_id=$2 AND NOT i.deleted`, [id, userId]);
    if (!it) throw notFound();
    return it;
  }

  app.post('/api/items/:id/favorite', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { favorite } = z.object({ favorite: z.boolean() }).parse(req.body);
    await ownItem(req.user!.id, id);
    await pool.query('UPDATE job_items SET favorite=$3 WHERE id=$1 AND user_id=$2', [id, req.user!.id, favorite]);
    await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [id, req.user!.id, favorite ? 'favorite' : 'unfavorite']);
    return { ok: true };
  });

  app.delete('/api/items/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownItem(req.user!.id, id);
    await pool.query('UPDATE job_items SET deleted=true, deleted_at=now() WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
    await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [id, req.user!.id, 'delete']);
    return { ok: true };
  });

  app.get('/api/items/:id/download', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const it = await ownItem(req.user!.id, id);
    if (!it.storage_key) throw notFound();
    if (it.purged_at) throw new HttpError(410, 'expired', `图片已超过 ${config.RETENTION_DAYS} 天保存期限，已被删除`);
    await pool.query('INSERT INTO generation_feedback(item_id, user_id, action) VALUES ($1,$2,$3)', [id, req.user!.id, 'download']);
    const ext = it.storage_key.endsWith('.png') ? 'png' : 'jpg';
    return { url: await signedUrl(it.storage_key, { ttl: 300, download: `lumi-${id.slice(0, 8)}.${ext}` }) };
  });

  // ---------- gallery & credits ----------
  app.get('/api/gallery', async (req) => {
    const q = z.object({ favorite: z.enum(['0', '1']).optional(), before: z.string().datetime().optional(), beforeId: z.string().uuid().optional() }).parse(req.query);
    const rows = await many<any>(pool, `SELECT i.*, a.storage_key, a.width, a.height, a.created_at AS asset_created_at, a.purged_at FROM job_items i JOIN assets a ON a.id=i.output_asset_id
      WHERE i.user_id=$1 AND i.status='succeeded' AND NOT i.deleted ${q.favorite === '1' ? 'AND i.favorite' : ''}
        AND ($2::timestamptz IS NULL OR ($3::uuid IS NULL AND i.created_at < $2) OR (date_trunc('milliseconds', i.created_at), i.id) < ($2, $3::uuid))
        ORDER BY date_trunc('milliseconds', i.created_at) DESC, i.id DESC LIMIT 60`, [req.user!.id, q.before ?? null, q.beforeId ?? null]);
    return Promise.all(rows.map(async (r) => ({ ...(await itemView(r)), createdAt: r.created_at })));
  });

  app.get('/api/credits/ledger', async (req) => {
    return many(pool, `SELECT delta, balance_after, reason, job_id, created_at FROM credit_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [req.user!.id]);
  });
}

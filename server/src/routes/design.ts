/**
 * 图层编辑器 support: the editable design behind a version, and local product cut-outs used as layers.
 * Saving goes through POST /api/items/:id/overlay (routes/work.ts) with the design document attached.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, one, many } from '../db/pool.js';
import { requireUser } from '../auth.js';
import { bad, notFound } from '../lib/errors.js';
import { getObject, putObject, signedUrl, thumbKey } from '../lib/storage.js';
import { sanitizeUpload, thumbnail } from '../lib/images.js';
import { cutoutImage, mattingAvailable } from '../services/matting.js';
import { PRODUCT_ROLES } from '../services/prompt.js';

const uuid = z.string().uuid();
const num = z.number().finite();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const FONTS = ['sans', 'serif', 'kuaile', 'huangyou', 'brush'] as const;

/** A design: layers drawn over the base image, in base-image pixels. */
export const designSchema = z.object({
  v: z.literal(1),
  w: z.number().int().min(64).max(8192),
  h: z.number().int().min(64).max(8192),
  layers: z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'), id: z.string().max(20), x: num, y: num, rot: num.default(0), opacity: num.min(0).max(1).default(1),
      text: z.string().max(60), font: z.enum(FONTS), size: num.min(4).max(2000), color, weight: z.union([z.literal(400), z.literal(700), z.literal(900)]),
      align: z.enum(['left', 'center', 'right']).default('center'), width: num.min(10).max(9000),
      stroke: color.nullable().default(null), strokeW: num.min(0).max(200).default(0), shadow: z.boolean().default(false),
      spacing: num.min(-50).max(200).default(0), lineHeight: num.min(0.8).max(3).default(1.2), hidden: z.boolean().default(false),
    }),
    z.object({
      type: z.literal('rect'), id: z.string().max(20), x: num, y: num, w: num.min(1).max(9000), h: num.min(1).max(9000), rot: num.default(0),
      opacity: num.min(0).max(1).default(1), fill: color, radius: num.min(0).max(4000).default(0), hidden: z.boolean().default(false),
    }),
    z.object({
      type: z.literal('image'), id: z.string().max(20), assetId: uuid, x: num, y: num, w: num.min(1).max(9000), h: num.min(1).max(9000),
      rot: num.default(0), opacity: num.min(0).max(1).default(1), role: z.enum(['product', 'logo', 'sticker']).default('sticker'),
      shadow: z.boolean().default(false), hidden: z.boolean().default(false),
    }),
  ])).max(40),
});
export type Design = z.infer<typeof designSchema>;

export default async function designRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { if (req.url.startsWith('/api/')) await requireUser(req); });

  /** What the editor opens on: the base image, the saved layers (for a design version), and the product photos. */
  app.get('/api/items/:id/design', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const userId = req.user!.id;
    const it = await one<any>(pool, 'SELECT * FROM job_items WHERE id=$1 AND user_id=$2 AND NOT deleted', [id, userId]);
    if (!it || it.status !== 'succeeded') throw notFound();
    const job = await one<any>(pool, 'SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [it.job_id, userId]);
    // A design version re-opens on its own base with its layers; anything else opens on its own image.
    const isDesign = it.planned_model === 'overlay' && it.design;
    let baseAssetId: string = it.output_asset_id;
    if (isDesign) {
      const b = await one<any>(pool, `SELECT asset_id FROM job_inputs WHERE job_id=$1 AND role='base' ORDER BY position LIMIT 1`, [job.id]);
      if (b) baseAssetId = b.asset_id;
    }
    const base = await one<any>(pool, 'SELECT id, storage_key, width, height, purged_at FROM assets WHERE id=$1 AND user_id=$2', [baseAssetId, userId]);
    if (!base || base.purged_at) throw bad('原图已超过保存期限被删除');
    // Product photos of the generation this image came from (walk up edits to the first non-edit job).
    let root = job; let guard = 0;
    while (root?.parent_item_id && guard++ < 12) {
      const p = await one<any>(pool, 'SELECT j.* FROM job_items i JOIN jobs j ON j.id=i.job_id WHERE i.id=$1 AND i.user_id=$2', [root.parent_item_id, userId]);
      if (!p) break; root = p;
      if (p.kind !== 'edit') break;
    }
    const prods = await many<any>(pool, `SELECT a.id, a.storage_key FROM job_inputs ji JOIN assets a ON a.id=ji.asset_id
      WHERE ji.job_id=$1 AND a.user_id=$2 AND a.purged_at IS NULL AND ji.role = ANY($3) ORDER BY ji.position LIMIT 3`, [root.id, userId, PRODUCT_ROLES]);
    const doc: Design | null = isDesign ? it.design : null;
    const assetIds = doc ? [...new Set(doc.layers.filter((l) => l.type === 'image').map((l: any) => l.assetId as string))] : [];
    const imgs = assetIds.length ? await many<any>(pool, 'SELECT id, storage_key FROM assets WHERE id = ANY($1) AND user_id=$2 AND purged_at IS NULL', [assetIds, userId]) : [];
    const assets: Record<string, string> = {};
    for (const a of imgs) assets[a.id] = await signedUrl(a.storage_key);
    return {
      itemId: it.id, base: { assetId: base.id, url: await signedUrl(base.storage_key), width: base.width, height: base.height },
      doc, assets,
      products: await Promise.all(prods.map(async (p) => ({ assetId: p.id, thumb: await signedUrl(thumbKey(p.storage_key)) }))),
      matting: mattingAvailable(),
    };
  });

  /** Cut the product out of one of the user's photos as a transparent PNG (a new upload asset), for use as a layer. */
  app.post('/api/assets/:id/cutout', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const userId = req.user!.id;
    if (!mattingAvailable()) throw bad('抠图暂不可用');
    const a = await one<any>(pool, 'SELECT id, storage_key, purged_at FROM assets WHERE id=$1 AND user_id=$2', [id, userId]);
    if (!a || a.purged_at) throw notFound();
    const png = await cutoutImage(await getObject(a.storage_key), { transparent: true });
    if (!png) throw bad('这张图里有多个物体，没法自动抠出商品');
    const img = await sanitizeUpload(png);
    const nid = randomUUID();
    const key = `uploads/${userId}/${nid}.${img.ext}`;
    await putObject(key, img.data, img.mime);
    await putObject(`thumbs/${userId}/${nid}.webp`, await thumbnail(img.data), 'image/webp');
    await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256) VALUES ($1,$2,'upload',$3,$4,$5,$6,$7,$8)`,
      [nid, userId, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
    return { id: nid, width: img.width, height: img.height, url: await signedUrl(key) };
  });
}

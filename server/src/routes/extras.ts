/**
 * P0/P1 extras: platform-size ZIP export + detail long image, product-link import, product library.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { fetch } from 'undici';
import { z } from 'zod';
import { pool, one, many } from '../db/pool.js';
import { requireUser } from '../auth.js';
import { bad, HttpError, notFound } from '../lib/errors.js';
import { getObject, putObject, signedUrl, thumbKey, deleteObjects } from '../lib/storage.js';
import { sanitizeUpload, thumbnail } from '../lib/images.js';
import { isPrivateIp, upstreamDispatcher } from '../lib/ssrf.js';
import { cleanSlot, promoTextViolation } from '../lib/textPolicy.js';
import { config } from '../config.js';

const uuid = z.string().uuid();

// ---------------------------------------------------------------- platform presets
type Size = [number, number];
const R = (a: Size, b: Size, c: Size, d: Size, e: Size): Record<string, Size> => ({ '1:1': a, '3:4': b, '9:16': c, '16:9': d, '4:3': e });
export const PRESETS: Record<string, { label: string; sizes: Record<string, Size> | null }> = {
  original: { label: '原图', sizes: null },
  taobao: { label: '淘宝天猫', sizes: R([800, 800], [750, 1000], [750, 1334], [1920, 1080], [800, 600]) },
  jd: { label: '京东', sizes: R([800, 800], [750, 1000], [750, 1334], [1920, 1080], [800, 600]) },
  pdd: { label: '拼多多', sizes: R([750, 750], [750, 1000], [750, 1334], [1920, 1080], [800, 600]) },
  douyin: { label: '抖店', sizes: R([800, 800], [900, 1200], [1080, 1920], [1920, 1080], [1200, 900]) },
  xhs: { label: '小红书', sizes: R([1242, 1242], [1242, 1656], [1080, 1920], [1920, 1080], [1440, 1080]) },
  amazon: { label: '亚马逊', sizes: R([2000, 2000], [1500, 2000], [1125, 2000], [2000, 1125], [2000, 1500]) },
};

// ---------------------------------------------------------------- minimal ZIP (store; images are already compressed)
function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dos = (() => { const d = new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dos.time, 10); lh.writeUInt16LE(dos.date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dos.time, 12); ch.writeUInt16LE(dos.date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function fitTo(buf: Buffer, size: Size | null): Promise<Buffer> {
  const p = sharp(buf, { limitInputPixels: 50_000_000 }).flatten({ background: '#ffffff' });
  return (size ? p.resize(size[0], size[1], { fit: 'cover', kernel: 'lanczos3' }) : p).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
}

// ---------------------------------------------------------------- link import helpers
const MAX_HTML = 3 * 1024 * 1024;
const MAX_IMG = 15 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad('链接格式不正确'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('只支持 http/https 链接');
  if (u.username || u.password) throw bad('链接里不能带账号密码');
  if (u.port && !['80', '443'].includes(u.port)) throw bad('不支持这个链接');
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw bad('打不开这个链接');
  if (addrs.some((a) => isPrivateIp(a.address))) throw bad('不支持这个链接');
  return u;
}

async function readLimited(res: Awaited<ReturnType<typeof fetch>>, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error('too large');
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
    n += c.length; if (n > max) throw new Error('too large');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/** GET with manual redirects (each hop re-validated), connect-time private-IP guard, size + time limits. */
async function safeGet(raw: string, max: number, accept: string) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, {
      redirect: 'manual', dispatcher: upstreamDispatcher(), signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6', Referer: `${u.origin}/` },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, u).toString(); await res.body?.cancel(); continue; }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`status ${res.status}`); }
    return { res, body: await readLimited(res, max), finalUrl: u };
  }
  throw new Error('too many redirects');
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function extractProduct(html: string, base: URL): { title: string; images: string[] } {
  const meta = (prop: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
    const m = html.match(re); return m ? decodeEntities(m[1] ?? m[2]) : '';
  };
  let title = meta('og:title') || meta('twitter:title') || (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] ?? '');
  title = decodeEntities(title).replace(/[-_|–—].{0,20}(淘宝|天猫|京东|拼多多|1688|tmall|taobao|jd\.com|amazon).*$/i, '').trim();
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string' || !v) return;
    let s = decodeEntities(v.trim()).replace(/\\\//g, '/');
    if (s.startsWith('//')) s = `${base.protocol}${s}`;
    try { s = new URL(s, base).toString(); } catch { return; }
    if (!/^https?:/i.test(s)) return;
    out.push(s);
  };
  push(meta('og:image')); push(meta('og:image:secure_url')); push(meta('twitter:image'));
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o: any) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (/product/i.test(String(o['@type'] ?? ''))) {
          if (!title && typeof o.name === 'string') title = o.name;
          const im = o.image; (Array.isArray(im) ? im : [im]).forEach((x: any) => push(typeof x === 'object' ? x?.url : x));
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1]));
    } catch { /* ignore bad json-ld */ }
  }
  // Image URLs anywhere in the page (galleries often live in inline scripts).
  for (const m of html.matchAll(/(?:https?:)?\/\/[^"'\s()<>\\]+?\.(?:jpe?g|png|webp)(?:_[^"'\s()<>\\]*)?/gi)) push(m[0]);
  // Normalise CDN size suffixes and dedupe; drop obvious sprites/icons/logos.
  const seen = new Set<string>();
  const images: string[] = [];
  for (const raw of out) {
    const u = raw.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, '$1').replace(/!\w+$/, '');
    const key = u.replace(/^https?:/, '').replace(/\?.*$/, '');
    if (seen.has(key) || /sprite|icon|logo|avatar|favicon|loading|blank|placeholder|\.gif/i.test(u)) continue;
    seen.add(key); images.push(u);
  }
  return { title: cleanSlot(title, 30), images: images.slice(0, 24) };
}

export default async function extrasRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { if (req.url.startsWith('/api/')) await requireUser(req); });

  app.get('/api/export/presets', async () => Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, sizes: p.sizes })));

  async function jobImages(userId: string, jobId: string, itemIds?: string[]) {
    const j = await one<any>(pool, 'SELECT id, created_at FROM jobs WHERE id=$1 AND user_id=$2', [jobId, userId]);
    if (!j) throw notFound();
    const rows = await many<any>(pool, `SELECT i.id, i.idx, i.ratio, a.storage_key FROM job_items i JOIN assets a ON a.id=i.output_asset_id
      WHERE i.job_id=$1 AND i.user_id=$2 AND i.status='succeeded' AND NOT i.deleted AND a.purged_at IS NULL
      ${itemIds?.length ? 'AND i.id = ANY($3::uuid[])' : ''} ORDER BY i.idx`, itemIds?.length ? [jobId, userId, itemIds] : [jobId, userId]);
    if (!rows.length) throw new HttpError(410, 'nothing', '这一批没有可下载的图片（可能已过期）');
    return { job: j, rows };
  }

  // ZIP of a batch at a platform's sizes.
  app.get('/api/jobs/:id/zip', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).default('original'), items: z.string().max(1200).optional() }).parse(req.query);
    const itemIds = q.items ? q.items.split(',').filter((x) => uuid.safeParse(x).success).slice(0, 32) : undefined;
    const { rows } = await jobImages(req.user!.id, id, itemIds);
    const preset = PRESETS[q.preset];
    const files: { name: string; data: Buffer }[] = [];
    for (const [k, r] of rows.entries()) {
      const size = preset.sizes?.[r.ratio] ?? null;
      const data = await fitTo(await getObject(r.storage_key), size);
      const dim = size ? `${size[0]}x${size[1]}` : r.ratio.replace(':', 'x');
      files.push({ name: `${String(k + 1).padStart(2, '0')}-${dim}.jpg`, data });
    }
    await pool.query(`INSERT INTO generation_feedback(item_id, user_id, action) SELECT unnest($1::uuid[]), $2, 'zip'`, [rows.map((r) => r.id), req.user!.id]);
    const name = `lumi-${preset.label}-${id.slice(0, 6)}.zip`;
    reply.header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="lumi-${q.preset}-${id.slice(0, 6)}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('Cache-Control', 'no-store');
    return reply.send(zipStore(files));
  });

  // Detail-page long image: the batch stacked vertically at one width (default 750, Taobao detail width).
  app.get('/api/jobs/:id/long', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ width: z.coerce.number().int().min(480).max(1500).default(750), items: z.string().max(1200).optional() }).parse(req.query);
    const itemIds = q.items ? q.items.split(',').filter((x) => uuid.safeParse(x).success).slice(0, 12) : undefined;
    const { rows } = await jobImages(req.user!.id, id, itemIds);
    const tiles = await Promise.all(rows.slice(0, 12).map(async (r) => {
      const b = await sharp(await getObject(r.storage_key)).flatten({ background: '#ffffff' }).resize({ width: q.width }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
      return b;
    }));
    const height = tiles.reduce((h, t) => h + t.info.height, 0);
    let top = 0;
    const out = await sharp({ create: { width: q.width, height, channels: 3, background: '#ffffff' } })
      .composite(tiles.map((t) => { const c = { input: t.data, top, left: 0 }; top += t.info.height; return c; }))
      .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    reply.header('Content-Type', 'image/jpeg')
      .header('Content-Disposition', `attachment; filename="lumi-detail-${id.slice(0, 6)}.jpg"`).header('Cache-Control', 'no-store');
    return reply.send(out);
  });

  // ---------------------------------------------------------------- link import
  app.post('/api/import/link', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (req) => {
    const { url } = z.object({ url: z.string().trim().min(8).max(2000) }).parse(req.body);
    const userId = req.user!.id;
    const m = url.match(/https?:\/\/[^\s，。"'<>]+/i); // tolerate share text around the link
    if (!m) throw bad('没有找到链接');
    let page;
    try { page = await safeGet(m[0], MAX_HTML, 'text/html,application/xhtml+xml'); }
    catch (e: any) { if (e instanceof HttpError) throw e; throw bad('打不开这个链接，可以换个链接或直接上传图片', 'link_unreachable'); }
    const html = page.body.toString('utf8');
    const { title, images } = extractProduct(html, page.finalUrl);
    const saved: { id: string; thumb: string; width: number; height: number }[] = [];
    for (const src of images) {
      if (saved.length >= 6) break;
      try {
        const { body } = await safeGet(src, MAX_IMG, 'image/avif,image/webp,image/*');
        const img = await sanitizeUpload(body);
        if (img.width < 300 || img.height < 300) continue;
        const id = randomUUID();
        const key = `uploads/${userId}/${id}.${img.ext}`;
        await putObject(key, img.data, img.mime);
        await putObject(`thumbs/${userId}/${id}.webp`, await thumbnail(img.data), 'image/webp');
        await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256)
          VALUES ($1,$2,'upload',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [id, userId, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
        saved.push({ id, thumb: await signedUrl(`thumbs/${userId}/${id}.webp`), width: img.width, height: img.height });
      } catch { /* skip this image */ }
    }
    if (!saved.length) throw new HttpError(422, 'no_images', '没有从这个链接读到商品图。淘宝、天猫等平台常要登录才能看，可以先把商品图保存下来再上传');
    return { title: promoTextViolation(title) ? '' : title, images: saved };
  });

  // ---------------------------------------------------------------- product library
  const productBody = z.object({
    name: z.string().trim().min(1).max(30),
    points: z.array(z.string().trim().max(24)).max(5).default([]),
    assetIds: z.array(uuid).min(1).max(3),
  });

  async function productView(r: any) {
    const assets = await many<any>(pool, 'SELECT id, storage_key, width, height FROM assets WHERE id = ANY($1::uuid[]) AND user_id=$2 AND purged_at IS NULL', [r.asset_ids, r.user_id]);
    const byId = new Map(assets.map((a) => [a.id, a]));
    return {
      id: r.id, name: r.name, points: r.points ?? [], updatedAt: r.updated_at,
      images: await Promise.all((r.asset_ids as string[]).filter((x) => byId.has(x)).map(async (x) => {
        const a = byId.get(x); return { id: a.id, width: a.width, height: a.height, thumb: await signedUrl(thumbKey(a.storage_key)) };
      })),
    };
  }

  app.get('/api/products', async (req) => {
    const rows = await many<any>(pool, 'SELECT * FROM products WHERE user_id=$1 AND NOT deleted ORDER BY updated_at DESC LIMIT 100', [req.user!.id]);
    return Promise.all(rows.map(productView));
  });

  app.post('/api/products', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = productBody.parse(req.body);
    const userId = req.user!.id;
    const name = cleanSlot(b.name, 30);
    const points = b.points.map((p) => cleanSlot(p, 24)).filter(Boolean);
    for (const t of [name, ...points]) { const v = promoTextViolation(t); if (v) throw bad(`商品资料里不能出现${v}`, 'promo_text'); }
    const n = await one<any>(pool, 'SELECT count(*)::int AS n FROM products WHERE user_id=$1 AND NOT deleted', [userId]);
    if (n.n >= 100) throw bad('商品库最多 100 个商品');
    const src = await many<any>(pool, 'SELECT id, storage_key, mime, width, height, bytes, sha256, kind, purged_at FROM assets WHERE id = ANY($1::uuid[]) AND user_id=$2', [b.assetIds, userId]);
    if (src.length !== new Set(b.assetIds).size) throw notFound();
    if (src.some((a) => a.purged_at)) throw new HttpError(410, 'asset_expired', '有图片已超过保存期限，请重新上传');
    // Library copies are kind 'product' so retention never deletes them.
    const ids: string[] = [];
    for (const aid of b.assetIds) {
      const a = src.find((x) => x.id === aid)!;
      if (a.kind === 'product') { ids.push(a.id); continue; }
      const id = randomUUID();
      const ext = a.storage_key.endsWith('.png') ? 'png' : 'jpg';
      const key = `products/${userId}/${id}.${ext}`;
      const data = await getObject(a.storage_key);
      await putObject(key, data, a.mime);
      await putObject(thumbKey(key), await thumbnail(data), 'image/webp');
      await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256) VALUES ($1,$2,'product',$3,$4,$5,$6,$7,$8)`,
        [id, userId, key, a.mime, a.width, a.height, a.bytes, a.sha256]);
      ids.push(id);
    }
    const r = await one<any>(pool, 'INSERT INTO products(user_id, name, points, asset_ids) VALUES ($1,$2,$3,$4) RETURNING *', [userId, name, JSON.stringify(points), ids]);
    return productView(r);
  });

  app.patch('/api/products/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(30).optional(), points: z.array(z.string().trim().max(24)).max(5).optional() }).parse(req.body);
    const name = b.name ? cleanSlot(b.name, 30) : null;
    const points = b.points ? b.points.map((p) => cleanSlot(p, 24)).filter(Boolean) : null;
    for (const t of [name ?? '', ...(points ?? [])]) { const v = promoTextViolation(t); if (v) throw bad(`商品资料里不能出现${v}`, 'promo_text'); }
    const r = await one<any>(pool, `UPDATE products SET name=COALESCE($3,name), points=COALESCE($4,points), updated_at=now()
      WHERE id=$1 AND user_id=$2 AND NOT deleted RETURNING *`, [id, req.user!.id, name, points ? JSON.stringify(points) : null]);
    if (!r) throw notFound();
    return productView(r);
  });

  app.delete('/api/products/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const userId = req.user!.id;
    const r = await one<any>(pool, 'UPDATE products SET deleted=true, updated_at=now() WHERE id=$1 AND user_id=$2 AND NOT deleted RETURNING asset_ids', [id, userId]);
    if (!r) throw notFound();
    // Delete library copies that no job still references within the retention window.
    const gone = await many<any>(pool, `UPDATE assets a SET purged_at=now() WHERE a.id = ANY($1::uuid[]) AND a.user_id=$2 AND a.kind='product'
      AND NOT EXISTS (SELECT 1 FROM products p WHERE p.user_id=$2 AND NOT p.deleted AND a.id = ANY(p.asset_ids))
      AND NOT EXISTS (SELECT 1 FROM job_inputs ji JOIN jobs j ON j.id=ji.job_id WHERE ji.asset_id=a.id AND j.created_at > now() - make_interval(days => $3))
      RETURNING storage_key`, [r.asset_ids, userId, config.RETENTION_DAYS]);
    if (gone.length) await deleteObjects(gone.flatMap((g) => [g.storage_key, thumbKey(g.storage_key)])).catch(() => 0);
    return { ok: true };
  });
}

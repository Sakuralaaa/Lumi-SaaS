/**
 * Local product matting (salient-object segmentation) with IS-Net general-use (DIS, Apache-2.0) on CPU.
 * One inference at a time per process (~3.5 s at 1024², ~1 GB RSS). The model is loaded lazily on first use.
 */
import { existsSync } from 'node:fs';
import sharp from 'sharp';

const MODEL = process.env.MATTING_MODEL || '/app/models/isnet-general-use.onnx';
const SIZE = 1024;

export interface Matte { width: number; height: number; alpha: Uint8Array }

let session: any = null;
let loading: Promise<any> | null = null;
let chain: Promise<unknown> = Promise.resolve();

export function mattingAvailable() { return existsSync(MODEL); }

async function getSession() {
  if (session) return session;
  if (!loading) loading = (async () => {
    const ort = await import('onnxruntime-node');
    session = await ort.InferenceSession.create(MODEL, { intraOpNumThreads: 2, interOpNumThreads: 1, executionProviders: ['cpu'] });
    return session;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Alpha matte (0–255) at the image's own size. Serialised: concurrent callers queue up. */
export function matte(buf: Buffer): Promise<Matte> {
  const run = chain.then(() => matteNow(buf));
  chain = run.catch(() => undefined);
  return run;
}

async function matteNow(buf: Buffer): Promise<Matte> {
  const ort = await import('onnxruntime-node');
  const s = await getSession();
  const img = sharp(buf, { failOn: 'none' }).rotate().removeAlpha().toColourspace('srgb');
  const meta = await img.clone().metadata();
  const { data: rgb, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = info.height;
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(SIZE, SIZE, { fit: 'fill', kernel: 'linear' }).raw().toBuffer();
  const n = SIZE * SIZE;
  const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    x[i] = small[i * 3] / 255 - 0.5;
    x[n + i] = small[i * 3 + 1] / 255 - 0.5;
    x[2 * n + i] = small[i * 3 + 2] / 255 - 0.5;
  }
  const feeds: Record<string, any> = { [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]) };
  const out = await s.run(feeds);
  const y = out[s.outputNames[0]].data as Float32Array;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = y[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const m = Buffer.alloc(n);
  for (let i = 0; i < n; i++) m[i] = Math.round(((y[i] - lo) / span) * 255);
  const alpha = await sharp(m, { raw: { width: SIZE, height: SIZE, channels: 1 } }).resize(width, height, { fit: 'fill', kernel: 'linear' }).extractChannel(0).raw().toBuffer();
  void meta;
  return { width, height, alpha: new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.length) };
}

/** RGB pixels of an image (EXIF-rotated, sRGB, no alpha). */
export async function rgbOf(buf: Buffer) {
  const { data, info } = await sharp(buf, { failOn: 'none' }).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** True when the matte is one dominant object (≥ 88% of the foreground in the largest blob): safe to cut out locally. */
export async function singleSubject(m: Matte) {
  const { components } = await import('./pasteback.js');
  const k = Math.min(1, 384 / Math.max(m.width, m.height));
  const w = Math.max(8, Math.round(m.width * k)), h = Math.max(8, Math.round(m.height * k));
  const small = await sharp(Buffer.from(m.alpha), { raw: { width: m.width, height: m.height, channels: 1 } }).resize(w, h, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
  const mask = Uint8Array.from(small, (v) => (v >= 128 ? 1 : 0));
  const { comps } = components(mask, w, h);
  const total = comps.reduce((a, c) => a + c.size, 0);
  return total > 0.005 * w * h && comps[0].size / total >= 0.88;
}

/** Product on white (or transparent) with a soft contact shadow; the product pixels are the photo's own.
 *  Returns null when the photo holds several separate objects (then a model decides what the product is). */
export async function cutoutImage(buf: Buffer, opts: { transparent?: boolean; ratio?: string } = {}) {
  const m = await matte(buf);
  if (!(await singleSubject(m))) return null;
  const src = await rgbOf(buf);
  const bb = bboxOf(m.alpha, m.width, m.height, 128);
  if (!bb) return null;
  const pad = 0;
  const cw = bb.x1 - bb.x0 + pad * 2, ch = bb.y1 - bb.y0 + pad * 2;
  const rgba = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = bb.x0 + x - pad, sy = bb.y0 + y - pad;
    const o = (y * cw + x) * 4;
    if (sx < 0 || sy < 0 || sx >= m.width || sy >= m.height) continue;
    const i = sy * m.width + sx;
    rgba[o] = src.data[i * 3]; rgba[o + 1] = src.data[i * 3 + 1]; rgba[o + 2] = src.data[i * 3 + 2]; rgba[o + 3] = m.alpha[i];
  }
  const piece = sharp(rgba, { raw: { width: cw, height: ch, channels: 4 } });
  if (opts.transparent) return piece.png().toBuffer();
  // Canvas: requested ratio (default square), product fills ~78% of the shorter side.
  const [rw, rh] = (opts.ratio ?? '1:1').split(':').map(Number);
  const W = 2048, H = Math.round(W * (rh || 1) / (rw || 1));
  const f = Math.min((W * 0.78) / cw, (H * 0.78) / ch);
  const pw = Math.max(1, Math.round(cw * f)), ph = Math.max(1, Math.round(ch * f));
  const px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
  const scaled = await piece.resize(pw, ph, { kernel: 'lanczos3' }).png().toBuffer();
  // Soft elliptical contact shadow under the product.
  const sw = Math.round(pw * 0.8), sh = Math.max(8, Math.round(ph * 0.05));
  const shadowSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.max(6, sh / 2)}"/></filter></defs><ellipse cx="${W / 2}" cy="${py + ph - sh * 0.25}" rx="${sw / 2}" ry="${sh / 2}" fill="rgba(0,0,0,0.16)" filter="url(#b)"/></svg>`);
  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite([{ input: shadowSvg, left: 0, top: 0 }, { input: scaled, left: px, top: py }])
    .jpeg({ quality: 93, mozjpeg: true }).toBuffer();
}

export function bboxOf(a: Uint8Array, w: number, h: number, th = 128) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) { const r = y * w; for (let x = 0; x < w; x++) if (a[r + x] >= th) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

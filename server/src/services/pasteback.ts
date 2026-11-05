/**
 * Product fidelity "paste-back": after a scene is generated, find where the product landed and lay the ORIGINAL
 * product pixels over it, keeping the generated scene's lighting (low frequencies) and the photo's detail (labels,
 * logos, small text, texture). Conservative: only applied when the generated product's silhouette matches the
 * original's almost exactly (same angle, unoccluded); otherwise the generated image is kept as is.
 */
import sharp from 'sharp';
import { matte, rgbOf, bboxOf, type Matte } from './matting.js';

export interface PasteResult { data: Buffer; iou: number; edge: number }
const MIN_IOU = 0.95;
const MIN_EDGE = 0.35;
const LIGHT = 0.85;

interface Src { w: number; h: number; rgb: Uint8Array; alpha: Uint8Array }

/** Crop of the original product (RGB + alpha) from a product photo and its matte. */
export async function productPiece(buf: Buffer, m?: Matte): Promise<Src | null> {
  const mm = m ?? await matte(buf);
  const rgb = await rgbOf(buf);
  const bb = bboxOf(mm.alpha, mm.width, mm.height, 128);
  if (!bb) return null;
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  if (w < 24 || h < 24) return null;
  const out = new Uint8Array(w * h * 3), a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (bb.y0 + y) * mm.width + bb.x0 + x, o = y * w + x;
    out[o * 3] = rgb.data[i * 3]; out[o * 3 + 1] = rgb.data[i * 3 + 1]; out[o * 3 + 2] = rgb.data[i * 3 + 2]; a[o] = mm.alpha[i];
  }
  return { w, h, rgb: out, alpha: a };
}

export function components(mask: Uint8Array, w: number, h: number) {
  const lab = new Int32Array(w * h);
  const comps: { id: number; size: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack = new Int32Array(w * h);
  let id = 0;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || lab[p]) continue;
    id++;
    let sp = 0, size = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = p; lab[p] = id;
    while (sp) {
      const q = stack[--sp]; size++;
      const x = q % w, y = (q / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - w] && !lab[q - w]) { lab[q - w] = id; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] && !lab[q + w]) { lab[q + w] = id; stack[sp++] = q + w; }
    }
    comps.push({ id, size, x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return { lab, comps: comps.sort((a, b) => b.size - a.size) };
}

/** Separable box blur ×3 (≈ Gaussian) on a float plane. */
function blurPlane(src: Float32Array, w: number, h: number, r: number) {
  let a = src, b = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    const c = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        c[y * w + x] = acc / (2 * r + 1);
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
    a = c;
  }
  return a;
}

function sobelMag(gray: Float32Array, w: number, h: number) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
    const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
    out[i] = Math.hypot(gx, gy);
  }
  return out;
}

function pearson(a: Float32Array, b: Float32Array, m: Uint8Array) {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) if (m[i]) { n++; sa += a[i]; sb += b[i]; }
  if (n < 50) return 0;
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) if (m[i]) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
  return cov / Math.sqrt(va * vb || 1);
}

/** Try to lay the original product (piece) over the generated image. null = not applied (silhouette mismatch). */
export async function pasteBack(piece: Src, genBuf: Buffer): Promise<PasteResult | null> {
  const gm = await matte(genBuf);
  const gen = await rgbOf(genBuf);
  const W = gen.width, H = gen.height;
  // Search at reduced resolution.
  const k = Math.min(1, 512 / Math.max(W, H));
  const sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k));
  const small = await sharp(Buffer.from(gm.alpha), { raw: { width: W, height: H, channels: 1 } }).resize(sw, sh, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
  const mask = new Uint8Array(sw * sh);
  for (let i = 0; i < mask.length; i++) mask[i] = small[i] >= 128 ? 1 : 0;
  const { lab, comps } = components(mask, sw, sh);
  const pa = piece.alpha, pw = piece.w, ph = piece.h;
  let best: { iou: number; x: number; y: number; w: number; h: number } | null = null;
  for (const c of comps.slice(0, 4)) {
    if (c.size < 0.01 * sw * sh) continue;
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    for (const base of [ch / ph, cw / pw]) for (let si = -3; si <= 3; si++) {
      const f = base * (1 + si * 0.02);
      const w = Math.max(2, Math.round(pw * f)), h = Math.max(2, Math.round(ph * f));
      for (const dx of [-4, -2, 0, 2, 4]) for (const dy of [-4, -2, 0, 2, 4]) {
        const px = Math.round(cx - w / 2 + dx), py = Math.round(cy - h / 2 + dy);
        let inter = 0, cand = 0;
        const x0 = Math.max(0, px), y0 = Math.max(0, py), x1 = Math.min(sw, px + w), y1 = Math.min(sh, py + h);
        for (let y = y0; y < y1; y++) {
          const sy = Math.min(ph - 1, (((y - py) + 0.5) / h * ph) | 0) * pw;
          const row = y * sw;
          for (let x = x0; x < x1; x++) {
            if (pa[sy + Math.min(pw - 1, (((x - px) + 0.5) / w * pw) | 0)] < 128) continue;
            cand++;
            if (lab[row + x] === c.id) inter++;
          }
        }
        const iou = inter / (cand + c.size - inter || 1);
        if (!best || iou > best.iou) best = { iou, x: px, y: py, w, h };
      }
    }
  }
  if (process.env.PB_DEBUG) console.log('pb best', best, comps.slice(0, 3).map((c) => c.size), sw, sh);
  if (!best || best.iou < MIN_IOU) return null;

  // Full-resolution placement.
  const X = Math.round(best.x / k), Y = Math.round(best.y / k), PW = Math.round(best.w / k), PH = Math.round(best.h / k);
  const s = await sharp(Buffer.from(piece.rgb), { raw: { width: pw, height: ph, channels: 3 } }).resize(PW, PH, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  const aRaw = await sharp(Buffer.from(pa), { raw: { width: pw, height: ph, channels: 1 } }).resize(PW, PH, { fit: 'fill', kernel: 'linear' }).extractChannel(0).raw().toBuffer();
  // Erode 1 px then feather, so no halo of the old background survives.
  const er = new Uint8Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    let m = 255;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      const v = xx < 0 || yy < 0 || xx >= PW || yy >= PH ? 0 : aRaw[yy * PW + xx];
      if (v < m) m = v;
    }
    er[y * PW + x] = m;
  }
  const af = blurPlane(Float32Array.from(er, (v) => v / 255), PW, PH, 1);

  const x0 = Math.max(0, X), y0 = Math.max(0, Y), x1 = Math.min(W, X + PW), y1 = Math.min(H, Y + PH);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 8 || rh < 8) return null;
  const A = new Float32Array(rw * rh);
  const G = [0, 1, 2].map(() => new Float32Array(rw * rh));
  const S = [0, 1, 2].map(() => new Float32Array(rw * rh));
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const o = y * rw + x, gi = (y0 + y) * W + x0 + x, si = (y0 + y - Y) * PW + (x0 + x - X);
    A[o] = af[si];
    for (let c = 0; c < 3; c++) { G[c][o] = gen.data[gi * 3 + c]; S[c][o] = s[si * 3 + c]; }
  }
  // Structure check: edges of the generated product vs the original, inside the product.
  const hard = Uint8Array.from(A, (v) => (v > 0.9 ? 1 : 0));
  const lum = (P: Float32Array[]) => Float32Array.from(P[0], (_, i) => 0.299 * P[0][i] + 0.587 * P[1][i] + 0.114 * P[2][i]);
  const gb = blurPlane(lum(G), rw, rh, 1), sb = blurPlane(lum(S), rw, rh, 1);
  const edge = pearson(sobelMag(gb, rw, rh), sobelMag(sb, rw, rh), hard);
  if (process.env.PB_DEBUG) console.log('pb edge', edge);
  if (edge < MIN_EDGE) return null;

  // Lighting transfer: low-pass(gen) − low-pass(src) added to the original, both masked by the product.
  const r = Math.max(3, Math.round(Math.min(PW, PH) * 0.04));
  const den = blurPlane(A, rw, rh, r);
  const out = Buffer.from(gen.data);
  const lowG: Float32Array[] = [], lowS: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const gm2 = blurPlane(Float32Array.from(G[c], (v, i) => v * A[i]), rw, rh, r);
    const sm2 = blurPlane(Float32Array.from(S[c], (v, i) => v * A[i]), rw, rh, r);
    lowG.push(gm2); lowS.push(sm2);
  }
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const o = y * rw + x, a = A[o];
    if (a <= 0.002) continue;
    const d = den[o] + 1e-4, gi = ((y0 + y) * W + x0 + x) * 3;
    for (let c = 0; c < 3; c++) {
      const v = S[c][o] + (lowG[c][o] / d - lowS[c][o] / d) * LIGHT;
      const p = Math.min(255, Math.max(0, v));
      out[gi + c] = Math.round(G[c][o] * (1 - a) + p * a);
    }
  }
  const data = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  return { data, iou: best.iou, edge };
}

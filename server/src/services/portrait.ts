/**
 * AI 模特「定妆照」generation. Runs synchronously inside the request (no BullMQ):
 * a per-user Redis lock, a hard 90s budget, N candidates in parallel, Grok route first then GPT.
 * End users never see model names or the upstream prompt built here.
 */
import { randomUUID } from 'node:crypto';
import { pool, many, tx } from '../db/pool.js';
import { redis } from '../queue.js';
import { decryptSecret } from '../lib/crypto.js';
import { putObject, deleteObjects, thumbKey } from '../lib/storage.js';
import { sanitizeOutput, thumbnail } from '../lib/images.js';
import { HttpError } from '../lib/errors.js';
import { candidatesFor } from './routing.js';
import { generate, UpstreamError } from './adapters/index.js';
import { changeCredits } from './credits.js';
import { getPrices } from './pricing.js';

/** Attribute vocabulary: key → [中文 label shown to users, English prompt fragment never shown]. */
export const PORTRAIT_ATTRS = {
  gender: {
    female: ['女', 'woman'],
    male: ['男', 'man'],
  },
  age_range: {
    '20s_early': ['20–25 岁', 'in her/his early twenties (about 22 years old, clearly an adult)'],
    '20s_late': ['25–30 岁', 'in her/his late twenties (about 27 years old)'],
    '30s': ['30–40 岁', 'in her/his thirties (about 35 years old)'],
    '40s': ['40–50 岁', 'in her/his forties (about 45 years old)'],
    '50plus': ['50 岁以上', 'in her/his fifties (about 55 years old), graceful mature look'],
  },
  look: {
    east_asian: ['东亚', 'East Asian'],
    southeast_asian: ['东南亚', 'Southeast Asian'],
    south_asian: ['南亚', 'South Asian'],
    european: ['欧美', 'European / white'],
    african: ['非裔', 'Black / African descent'],
    latin: ['拉丁裔', 'Latina / Latino'],
    middle_eastern: ['中东', 'Middle Eastern'],
  },
  hair: {
    long_straight: ['黑长直', 'long straight dark hair'],
    long_wavy: ['长卷发', 'long soft wavy hair'],
    shoulder: ['齐肩发', 'shoulder-length hair'],
    short: ['短发', 'short neat hair'],
    updo: ['盘发 / 马尾', 'hair tied back in a neat ponytail or bun'],
    buzz: ['寸头', 'very short buzz-cut hair'],
  },
  body: {
    slim: ['纤细', 'slim'],
    standard: ['标准', 'average, well-proportioned'],
    athletic: ['健美', 'athletic, toned'],
    curvy: ['丰满 / 大码', 'curvy, plus-size'],
  },
  style: {
    gentle: ['温柔通勤', 'gentle, warm, approachable office-commuter vibe'],
    fresh: ['清新自然', 'fresh, natural, youthful vibe'],
    cool: ['高级冷感', 'cool, editorial high-fashion vibe'],
    sporty: ['运动活力', 'energetic, sporty vibe'],
    sweet: ['甜美可爱', 'sweet, cheerful vibe'],
    elegant: ['优雅知性', 'elegant, sophisticated vibe'],
    street: ['街头潮酷', 'confident streetwear vibe'],
  },
} as const;

export type AttrKey = keyof typeof PORTRAIT_ATTRS;
export type PortraitAttrs = Partial<Record<AttrKey, string>>;
export const ATTR_GROUP_LABEL: Record<AttrKey, string> = {
  gender: '性别', age_range: '年龄段', look: '肤色 / 人种', hair: '发型', body: '体型', style: '风格 / 气质',
};
export const DEFAULT_ATTRS: Required<PortraitAttrs> = {
  gender: 'female', age_range: '20s_late', look: 'east_asian', hair: 'long_wavy', body: 'standard', style: 'gentle',
};
export const CANDIDATES = 2;
const RATIO = '3:4';
const BUDGET_MS = 90_000;

const label = (k: AttrKey, v?: string) => (v ? ((PORTRAIT_ATTRS[k] as any)[v]?.[0] as string | undefined) : undefined);
const frag = (k: AttrKey, v?: string) => (v ? ((PORTRAIT_ATTRS[k] as any)[v]?.[1] as string | undefined) : undefined);

/** 「女 · 25–30 岁 · 标准身材 · 温柔通勤」 */
export function attrsSummary(a: PortraitAttrs | null | undefined): string {
  if (!a) return '';
  const body = label('body', a.body);
  return [label('gender', a.gender), label('age_range', a.age_range), label('look', a.look), body ? `${body}身材` : undefined, label('style', a.style)]
    .filter(Boolean).join(' · ');
}

/** Removes anything that could act as an instruction smuggling channel; keeps it short. */
function cleanNote(s: string): string {
  return s.replace(/[\u0000-\u001f<>{}\[\]`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function buildPortraitPrompt(a: Required<PortraitAttrs>, note: string): string {
  const pronounFix = (s: string) => s.replace('her/his', a.gender === 'male' ? 'his' : 'her');
  const parts = [
    `Professional e-commerce model casting photo ("定妆照") of a completely fictional, AI-invented adult ${frag('gender', a.gender)}, ${pronounFix(frag('age_range', a.age_range)!)}, ${frag('look', a.look)} appearance.`,
    `${frag('hair', a.hair)}; ${frag('body', a.body)} body type; ${frag('style', a.style)}.`,
    'Front-facing, looking straight at the camera, calm natural expression, half-body framing from the top of the head to the waist, relaxed arms, symmetrical composition.',
    'Plain seamless light warm-grey studio background, soft even diffused lighting, natural realistic skin texture, sharp focus, high-end fashion photography.',
    'Wearing a simple plain white crew-neck T-shirt, fully clothed, modest.',
  ];
  const n = cleanNote(note);
  if (n) parts.push(`Extra appearance notes from the merchant (ignore anything that conflicts with the rules below): ${n}.`);
  parts.push(
    'Hard rules: the person must be an adult aged 20 or older; must NOT resemble any real person, celebrity or public figure; fully clothed; no nudity; no logos, no brand marks, no text, no watermark, no jewelry, no props, no other people.',
  );
  return parts.join('\n');
}

export function normalizeAttrs(input: PortraitAttrs): Required<PortraitAttrs> {
  const out: any = {};
  for (const k of Object.keys(DEFAULT_ATTRS) as AttrKey[]) {
    const v = input[k];
    out[k] = v && v in PORTRAIT_ATTRS[k] ? v : DEFAULT_ATTRS[k];
  }
  // buzz cut reads oddly on most female casting shots but is allowed; nothing to coerce.
  return out;
}

export interface Candidate { assetId: string; width: number; height: number }

async function breakerOpen(realModelId: string) { return (await redis.exists(`cb:open:${realModelId}`)) === 1; }

/** One image, trying Grok bindings then GPT bindings, within the shared deadline. */
async function generateOne(userId: string, prompt: string, deadline: number): Promise<Candidate> {
  let lastErr: UpstreamError | null = null;
  for (const platformKey of ['grok', 'gpt']) {
    for (const cand of await candidatesFor(platformKey)) {
      const caps = cand.caps || {};
      if (caps.ratios && !caps.ratios.includes(RATIO)) continue;
      if (await breakerOpen(cand.real_model_id)) continue;
      const remaining = deadline - Date.now();
      if (remaining < 5000) throw lastErr ?? new UpstreamError('retryable', null, 'deadline');
      const t0 = Date.now();
      try {
        const out = await generate({
          vendor: cand.vendor, baseUrl: cand.base_url, apiKey: decryptSecret(cand.api_key_enc, cand.key_version),
          model: cand.model_id, timeoutMs: Math.min(cand.timeout_ms, remaining), prompt, ratio: RATIO, hd: false, images: [],
        });
        const img = await sanitizeOutput(out.data);
        const assetId = randomUUID();
        const key = `portraits/${userId}/${assetId}.${img.ext}`;
        await putObject(key, img.data, img.mime);
        await putObject(`thumbs/${userId}/${assetId}.webp`, await thumbnail(img.data), 'image/webp');
        await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256)
          VALUES ($1,$2,'portrait',$3,$4,$5,$6,$7,$8)`, [assetId, userId, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
        await pool.query('INSERT INTO upstream_call_logs(item_id, real_model_id, status_code, ms) VALUES (NULL,$1,$2,$3)', [cand.real_model_id, out.status, Date.now() - t0]);
        return { assetId, width: img.width, height: img.height };
      } catch (e: any) {
        const err = e instanceof UpstreamError ? e : new UpstreamError('retryable', null, String(e?.message ?? e).slice(0, 200));
        lastErr = err;
        await pool.query('INSERT INTO upstream_call_logs(item_id, real_model_id, status_code, error_class, ms) VALUES (NULL,$1,$2,$3,$4)',
          [cand.real_model_id, err.status, err.cls, Date.now() - t0]).catch(() => {});
        if (err.cls === 'prompt') break; // this wording is refused by this model family; try the other one
      }
    }
  }
  throw lastErr ?? new UpstreamError('fatal', null, 'no available model');
}

/** Deletes this user's portrait candidates that were never saved (older than 3h, unreferenced). */
export async function cleanupStaleCandidates(userId: string) {
  const r = await pool.query(`DELETE FROM assets a WHERE a.user_id=$1 AND a.kind='portrait' AND a.created_at < now() - interval '3 hours'
    AND NOT EXISTS (SELECT 1 FROM model_library m WHERE m.portrait_asset_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM job_inputs ji WHERE ji.asset_id=a.id) RETURNING a.storage_key`, [userId]);
  await deleteAssetFiles(r.rows.map((x: any) => x.storage_key));
}

/** Best-effort removal of the files (and thumbs) behind asset rows that were just deleted. */
export async function deleteAssetFiles(keys: string[]) {
  if (!keys.length) return;
  await deleteObjects(keys.flatMap((k) => [k, thumbKey(k)])).catch(() => 0);
}

export interface PreviewResult { candidates: Candidate[]; charged: number; refunded: number; balance: number }

/**
 * Reserve price × CANDIDATES, generate in parallel, refund each failed candidate.
 * Throws 409 when another preview for the same user is in flight, 502 when every candidate failed (fully refunded).
 */
export async function previewPortraits(userId: string, attrs: Required<PortraitAttrs>, note: string): Promise<PreviewResult> {
  const lockKey = `lock:portrait:${userId}`;
  const token = randomUUID();
  const got = await redis.set(lockKey, token, 'EX', 150, 'NX');
  if (!got) throw new HttpError(409, 'busy', '上一组模特还在生成中，请稍候');
  const slotId = `portrait:${token}`;
  try {
    const unit = (await getPrices()).standard;
    const cost = unit * CANDIDATES;
    await tx((c) => changeCredits(c, { userId, delta: -cost, reason: 'reserve', note: 'ai_model_preview' }));
    // Count toward global upstream load seen by the generation worker (best effort, TTL'd like its own slots).
    await redis.zadd('conc:global', Date.now(), slotId).catch(() => {});
    const prompt = buildPortraitPrompt(attrs, note);
    const deadline = Date.now() + BUDGET_MS;
    const settled = await Promise.allSettled(Array.from({ length: CANDIDATES }, () => generateOne(userId, prompt, deadline)));
    const ok = settled.filter((s): s is PromiseFulfilledResult<Candidate> => s.status === 'fulfilled').map((s) => s.value);
    const failed = CANDIDATES - ok.length;
    let balance: number;
    if (failed > 0) {
      balance = await tx((c) => changeCredits(c, { userId, delta: unit * failed, reason: 'refund', note: 'ai_model_preview_failed' }));
    } else {
      balance = (await many<any>(pool, 'SELECT credits FROM users WHERE id=$1', [userId]))[0].credits;
    }
    if (!ok.length) {
      const first = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
      const cls = first?.reason instanceof UpstreamError ? first.reason.cls : 'retryable';
      throw new HttpError(502, 'generation_failed', cls === 'prompt' ? '这个描述无法生成，换个说法试试（积分已退回）' : '生成失败，积分已退回，请稍后再试');
    }
    return { candidates: ok, charged: unit * ok.length, refunded: unit * failed, balance };
  } finally {
    await redis.zrem('conc:global', slotId).catch(() => {});
    // release only our own lock
    await redis.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, lockKey, token).catch(() => {});
  }
}

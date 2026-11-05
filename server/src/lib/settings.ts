import { z } from 'zod';
import { pool } from '../db/pool.js';

export const DEFAULT_SETTINGS = {
  concurrency_user: 2,
  concurrency_global: 10,
  beta_default_credits: 200,
  beta_daily_image_limit: 50,
  mix_batch_enabled: true,
  signup_enabled: true,
  feature_user_referral: false,
  max_images_per_job: 8,
  // Planner layer (vision/chat LLM that writes the upstream image prompt). Empty channel/model = planner skipped.
  planner_enabled: true,
  planner_channel_id: '',
  planner_model: '',
  // Automatic QC of each generated image with the planner's vision model; one free automatic re-generation on a clear failure.
  qc_enabled: true,
  // Product fidelity: lay the original product pixels back over generated scenes when the silhouette matches (local matting).
  fidelity_enabled: true,
} as const;
type Widen<T> = T extends boolean ? boolean : T extends string ? string : number;
export type Settings = { -readonly [K in keyof typeof DEFAULT_SETTINGS]: Widen<(typeof DEFAULT_SETTINGS)[K]> };

/** Validation for PUT /api/admin/settings: every key optional, unknown keys rejected. */
const STRING_RULES: Record<string, z.ZodType<string>> = {
  planner_channel_id: z.union([z.literal(''), z.string().uuid()]),
  planner_model: z.string().trim().max(120).regex(/^[A-Za-z0-9._:/@-]*$/, '模型名只能包含字母数字和 ._:/@-'),
};
export const settingsUpdateSchema = z.object(Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k,
  (typeof v === 'boolean' ? z.boolean() : typeof v === 'string' ? (STRING_RULES[k] ?? z.string().max(200)) : z.number().int().min(0).max(100000)).optional(),
]))).strict();

let cache: { at: number; v: Settings } | null = null;
export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5000) return cache.v;
  const rows = (await pool.query('SELECT key, value FROM settings')).rows;
  const v: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in v && typeof r.value === typeof v[r.key]) v[r.key] = r.value;
  cache = { at: Date.now(), v };
  return v;
}
export function invalidateSettings() { cache = null; }

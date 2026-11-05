import { pool, many } from '../db/pool.js';
import type { Quality } from './pricing.js';

export interface RouteInput { quality: Quality; refs: number; tags: string[] }
export interface Rule { id: string; name: string; priority: number; match: any; primary_model: string; fallback_model: string | null }

export function matchRule(rules: Rule[], i: RouteInput): Rule | null {
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    const m = r.match || {};
    if (m.quality && m.quality !== i.quality) continue;
    if (m.min_refs != null && i.refs < m.min_refs) continue;
    if (m.max_refs != null && i.refs > m.max_refs) continue;
    if (Array.isArray(m.tags_any) && m.tags_any.length && !m.tags_any.some((t: string) => i.tags.includes(t))) continue;
    return r;
  }
  return null;
}

export async function loadRules(): Promise<Rule[]> {
  return many<Rule>(pool, 'SELECT id, name, priority, match, primary_model, fallback_model FROM routing_rules WHERE enabled ORDER BY priority');
}

/** Plan which platform model each image of a batch goes to. Mixing applies only when both models can take the job. */
export function planBatch(rule: Rule, n: number, mix: boolean, canMix: boolean): string[] {
  if (!mix || !canMix || n < 2 || !rule.fallback_model) return Array(n).fill(rule.primary_model);
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? rule.primary_model : rule.fallback_model!));
}

export interface Candidate {
  real_model_id: string; model_id: string; caps: any; cost_standard_fen: number; cost_hd_fen: number;
  channel_id: string; vendor: string; base_url: string; api_key_enc: Buffer; key_version: number; timeout_ms: number;
  priority: number; weight: number;
}

/** Enabled bindings for a platform model, grouped by priority, weighted-shuffled inside a group. */
export async function candidatesFor(platformKey: string): Promise<Candidate[]> {
  const rows = await many<Candidate>(pool, `
    SELECT rm.id AS real_model_id, rm.model_id, rm.caps, rm.cost_standard_fen, rm.cost_hd_fen,
           ch.id AS channel_id, ch.vendor, ch.base_url, ch.api_key_enc, ch.key_version, ch.timeout_ms,
           rb.priority, rb.weight
      FROM route_bindings rb
      JOIN platform_models pm ON pm.key = rb.platform_model_key AND pm.enabled
      JOIN real_models rm ON rm.id = rb.real_model_id AND rm.enabled
      JOIN upstream_channels ch ON ch.id = rm.channel_id AND ch.status = 'active' AND ch.purpose = 'image'
     WHERE rb.platform_model_key = $1 AND rb.enabled
     ORDER BY rb.priority`, [platformKey]);
  const groups = new Map<number, Candidate[]>();
  for (const r of rows) groups.set(r.priority, [...(groups.get(r.priority) ?? []), r]);
  const out: Candidate[] = [];
  for (const p of [...groups.keys()].sort((a, b) => a - b)) {
    const g = [...groups.get(p)!];
    while (g.length) {
      const total = g.reduce((s, x) => s + x.weight, 0);
      let pick = Math.random() * total;
      const i = g.findIndex((x) => (pick -= x.weight) < 0);
      out.push(...g.splice(i < 0 ? 0 : i, 1));
    }
  }
  return out;
}

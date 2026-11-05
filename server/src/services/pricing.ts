import { pool } from '../db/pool.js';
export type Quality = 'standard' | 'hd';
export async function getPrices(): Promise<Record<Quality, number>> {
  const rows = (await pool.query('SELECT quality, credits FROM pricing')).rows;
  const p: any = {};
  for (const r of rows) p[r.quality] = r.credits;
  if (!p.standard || !p.hd) throw new Error('pricing not configured');
  return p;
}

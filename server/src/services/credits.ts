import type { PoolClient } from 'pg';
import { HttpError } from '../lib/errors.js';

type Reason = 'invite_grant' | 'reserve' | 'refund' | 'admin_adjust';

/** Atomically change a user's balance and append to the ledger. Must run inside a transaction. */
export async function changeCredits(c: PoolClient, a: { userId: string; delta: number; reason: Reason; jobId?: string; itemId?: string; actorId?: string; note?: string }) {
  const r = await c.query(
    'UPDATE users SET credits = credits + $2 WHERE id = $1 AND credits + $2 >= 0 RETURNING credits',
    [a.userId, a.delta]);
  if (!r.rowCount) throw new HttpError(402, 'insufficient_credits', '积分不足');
  const balance = r.rows[0].credits as number;
  await c.query(
    'INSERT INTO credit_ledger(user_id, delta, balance_after, reason, job_id, item_id, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [a.userId, a.delta, balance, a.reason, a.jobId ?? null, a.itemId ?? null, a.actorId ?? null, a.note ?? null]);
  return balance;
}

import { pool, type Q } from '../db/pool.js';

export async function audit(a: { actorId?: string | null; action: string; targetType?: string; targetId?: string; ip?: string; meta?: object }, q: Q = pool) {
  await q.query('INSERT INTO audit_logs(actor_id, action, target_type, target_id, ip, meta) VALUES ($1,$2,$3,$4,$5,$6)',
    [a.actorId ?? null, a.action, a.targetType ?? null, a.targetId ?? null, a.ip ?? null, JSON.stringify(a.meta ?? {})]);
}

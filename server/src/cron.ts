/**
 * Ops cron — a separate process (`node server/dist/cron.js`, compose service `cron`).
 *
 * Hourly (guarded by a Redis lock so only one replica runs it per ~55 min):
 *   - retention: delete files of uploads/outputs older than RETENTION_DAYS (default 30)
 *   - files of soft-deleted items after 24h; uploads never used in a job after 7 days
 *   - expired sessions, idempotency keys > 24h, upstream_call_logs > 90 days
 * Every 30s: alert checks (upstream failure rate, circuit breakers open).
 *
 * Asset rows are kept and marked `purged_at`; the API then returns `expired: true` and no URL.
 * Never touched: kinds other than upload/output (e.g. 'portrait'), and any asset referenced from
 * another table by a foreign key (or *asset_id column of inspiration_templates / model_library) —
 * discovered via information_schema at runtime, so it works before/after those migrations land.
 *
 * CLI: `cron.ts --once [--force]` runs retention once and exits (--force ignores the hourly lock).
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from './config.js';
import { pool, many, one } from './db/pool.js';
import { redis, genQueue } from './queue.js';
import { deleteObjects, thumbKey } from './lib/storage.js';
import { sendAlert } from './lib/alert.js';

const BATCH = 500;
const MAX_BATCHES = 200; // per category per run (≤100k assets) so one run stays bounded
const RETENTION_LOCK = 'lumi:cron:retention';
const CHECK_LOCK = 'lumi:cron:checks';

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** SQL predicates (on alias `a`) that are true when an asset is referenced by something we must keep. */
export async function protectedPredicates(): Promise<string[]> {
  const rows = await many<{ table_name: string; column_name: string; is_array: boolean }>(pool, `
    SELECT DISTINCT kcu.table_name, kcu.column_name, false AS is_array
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()
       AND ccu.table_name = 'assets' AND ccu.column_name = 'id'
       AND kcu.table_name NOT IN ('job_inputs', 'job_items', 'projects', 'assets')
    UNION
    SELECT table_name, column_name, udt_name = '_uuid' AS is_array
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ('inspiration_templates', 'model_library')
       AND column_name ~ 'asset_ids?$' AND udt_name IN ('uuid', '_uuid')`);
  return rows.map((r) => r.is_array
    ? `EXISTS (SELECT 1 FROM ${qi(r.table_name)} x WHERE a.id = ANY(x.${qi(r.column_name)}))`
    : `EXISTS (SELECT 1 FROM ${qi(r.table_name)} x WHERE x.${qi(r.column_name)} = a.id)`);
}

/** Select→delete files→mark, in batches. Returns number of assets purged. */
async function purge(name: string, where: string, params: unknown[], protect: string[]): Promise<number> {
  const guard = protect.map((p) => `AND NOT ${p}`).join(' ');
  let total = 0;
  for (let b = 0; b < MAX_BATCHES; b++) {
    const rows = await many<{ id: string; storage_key: string }>(pool, `
      SELECT a.id, a.storage_key FROM assets a
       WHERE a.purged_at IS NULL AND ${where} ${guard}
       ORDER BY a.created_at LIMIT ${BATCH}`, params);
    if (!rows.length) break;
    const keys = rows.flatMap((r) => [r.storage_key, thumbKey(r.storage_key)]);
    const failed = await deleteObjects(keys);
    if (failed) throw new Error(`${name}: ${failed} storage objects failed to delete (batch not marked, will retry)`);
    await pool.query('UPDATE assets SET purged_at = now() WHERE id = ANY($1::uuid[]) AND purged_at IS NULL', [rows.map((r) => r.id)]);
    total += rows.length;
    if (rows.length < BATCH) break;
  }
  return total;
}

async function deleteInBatches(table: string, pk: string, where: string, params: unknown[] = []): Promise<number> {
  let total = 0;
  for (let b = 0; b < MAX_BATCHES * 10; b++) {
    const r = await pool.query(`DELETE FROM ${table} WHERE ${pk} IN (SELECT ${pk} FROM ${table} WHERE ${where} LIMIT 5000)`, params);
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < 5000) break;
  }
  return total;
}

export async function runRetention() {
  const t0 = Date.now();
  const days = config.RETENTION_DAYS;
  const protect = await protectedPredicates();
  // An asset used as an input by a job inside the retention window stays (so recent jobs can be re-run).
  const recentInput = `NOT EXISTS (SELECT 1 FROM job_inputs ji JOIN jobs j ON j.id = ji.job_id
      WHERE ji.asset_id = a.id AND (j.created_at > now() - make_interval(days => $1) OR j.status IN ('queued','running')))`;

  const counts: Record<string, number> = {};
  counts.expired = await purge('retention',
    `a.kind IN ('upload','output') AND a.created_at < now() - make_interval(days => $1) AND ${recentInput}`, [days], protect);
  counts.deletedItems = await purge('soft-deleted',
    `a.kind = 'output'
     AND EXISTS (SELECT 1 FROM job_items i WHERE i.output_asset_id = a.id AND i.deleted AND i.deleted_at < now() - interval '24 hours')
     AND NOT EXISTS (SELECT 1 FROM job_items i WHERE i.output_asset_id = a.id AND NOT i.deleted)
     AND ${recentInput}`, [days], protect);
  counts.orphanUploads = await purge('orphan-uploads',
    `a.kind = 'upload' AND a.created_at < now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM job_inputs ji WHERE ji.asset_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.cover_asset_id = a.id)`, [], protect);
  counts.sessions = await deleteInBatches('sessions', 'token_hash', 'expires_at < now()');
  counts.idempotencyKeys = await deleteInBatches('idempotency_keys', 'ctid', `created_at < now() - interval '24 hours'`);
  counts.upstreamLogs = await deleteInBatches('upstream_call_logs', 'id', `created_at < now() - interval '90 days'`);
  console.log(JSON.stringify({ msg: 'cron.retention', retentionDays: days, protectedRefs: protect.length, ...counts, ms: Date.now() - t0 }));
  return counts;
}

/** Upstream failure rate over the last 15 min and open circuit breakers (keys set by the worker). */
export async function runChecks() {
  const r = await one<{ total: number; failed: number }>(pool, `
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE error_class IS NOT NULL AND error_class NOT IN ('prompt','invalid'))::int AS failed
      FROM upstream_call_logs WHERE created_at > now() - interval '15 minutes'`);
  if (r && r.total >= 10 && r.failed / r.total > 0.3) {
    const top = await many<any>(pool, `
      SELECT COALESCE(ch.name || ' / ' || rm.model_id, l.real_model_id::text, '?') AS model, l.error_class, count(*)::int AS n
        FROM upstream_call_logs l LEFT JOIN real_models rm ON rm.id = l.real_model_id LEFT JOIN upstream_channels ch ON ch.id = rm.channel_id
       WHERE l.created_at > now() - interval '15 minutes' AND l.error_class IS NOT NULL
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5`);
    await sendAlert('upstream_failure_rate', `上游失败率 ${Math.round((r.failed / r.total) * 100)}%（近 15 分钟 ${r.failed}/${r.total}）`,
      top.map((t) => `${t.model}: ${t.error_class} ×${t.n}`).join('\n'));
  }
  const open: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'cb:open:*', 'COUNT', 200);
    cursor = next;
    open.push(...keys.map((k) => k.slice('cb:open:'.length)));
  } while (cursor !== '0');
  if (open.length) {
    const ids = open.filter((x) => /^[0-9a-f-]{36}$/.test(x));
    const names = ids.length ? await many<any>(pool, `SELECT rm.id, ch.name || ' / ' || rm.model_id AS name FROM real_models rm
      JOIN upstream_channels ch ON ch.id = rm.channel_id WHERE rm.id = ANY($1::uuid[])`, [ids]) : [];
    const label = (id: string) => names.find((n) => n.id === id)?.name ?? id;
    await sendAlert('circuit_open', `上游熔断已打开（${open.length} 个模型）`, open.map(label).join('\n'));
  }
}

async function retentionTick(force = false) {
  // The lock is intentionally not released: it doubles as "ran within the last 55 minutes".
  if (!force && (await redis.set(RETENTION_LOCK, String(Date.now()), 'EX', 55 * 60, 'NX')) !== 'OK') return;
  try {
    await runRetention();
  } catch (e: any) {
    console.error('cron.retention failed', e);
    await redis.del(RETENTION_LOCK).catch(() => {}); // retry on the next tick
    await sendAlert('cron_failed', '定时清理任务失败', String(e?.message ?? e).slice(0, 500));
  }
}

async function checksTick() {
  if ((await redis.set(CHECK_LOCK, '1', 'EX', 25, 'NX')) !== 'OK') return;
  try { await runChecks(); } catch (e: any) {
    console.error('cron.checks failed', e);
    await sendAlert('cron_failed', '告警检查任务失败', String(e?.message ?? e).slice(0, 500));
  }
}

async function shutdown(code = 0) {
  await Promise.allSettled([pool.end(), redis.quit(), genQueue.close()]);
  process.exit(code);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--once')) {
    try {
      await retentionTick(args.includes('--force'));
      await shutdown(0);
    } catch (e) { console.error(e); await shutdown(1); }
  } else {
    console.log(`cron started (retention ${config.RETENTION_DAYS}d, alerts ${config.ALERT_WEBHOOK_URL ? 'on' : 'off'})`);
    let busy = false;
    const loop = async () => {
      if (busy) return;
      busy = true;
      try { await checksTick(); await retentionTick(); } catch (e) { console.error('cron tick', e); } finally { busy = false; }
    };
    void loop();
    setInterval(loop, 30_000);
    process.on('SIGTERM', () => void shutdown(0));
    process.on('SIGINT', () => void shutdown(0));
  }
}

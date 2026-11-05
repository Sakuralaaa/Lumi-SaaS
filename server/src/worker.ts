import { Worker, DelayedError, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { pool, one, many, tx } from './db/pool.js';
import { connection, QUEUE, redis } from './queue.js';
import { getSettings } from './lib/settings.js';
import { decryptSecret } from './lib/crypto.js';
import { getObject, putObject } from './lib/storage.js';
import { sanitizeOutput, thumbnail } from './lib/images.js';
import { candidatesFor, type Candidate } from './services/routing.js';
import { buildEditPrompt, buildTemplatePrompt, buildPrompt, composePlannedPrompt, EDIT_OPS, PRODUCT_ROLES, isTextTag, type EditOp } from './services/prompt.js';
import { getPlan, qcCheck, type QcResult } from './services/planner.js';
import { sceneForShot } from './services/templates/scenes.js';
import { trimRefs } from './services/refs.js';
import { generate, UpstreamError } from './services/adapters/index.js';
import { changeCredits } from './services/credits.js';
import { cutoutImage, mattingAvailable } from './services/matting.js';
import { pasteBack, productPiece } from './services/pasteback.js';
import { getPrices } from './services/pricing.js';

interface Data { itemId: string; userId: string; primaryModel?: string; fallbackModel: string | null; quotaRequeues?: number }

/** Grok "no available image quota" (usually the key's concurrency cap): send the item to the back of the queue up to
 *  QUOTA_REQUEUES times, then let GPT take it. */
const QUOTA_REQUEUES = 3;
const REQUEUE_MODEL = 'grok';
const LAST_RESORT_MODEL = 'gpt';

// ---- product fidelity (paste-back of the original product) ----
const NO_PASTE_TAGS = new Set(['model_wear', 'street', 'detail', 'angles']);
const pieceCache = new Map<string, Awaited<ReturnType<typeof productPiece>>>();
async function pieceFor(assetId: string, data: Buffer) {
  if (pieceCache.has(assetId)) return pieceCache.get(assetId)!;
  const p = await productPiece(data).catch(() => null);
  pieceCache.set(assetId, p);
  if (pieceCache.size > 24) pieceCache.delete(pieceCache.keys().next().value!);
  return p;
}

// ---- concurrency: per-user and global slots in Redis (with TTL so a crash cannot leak slots forever) ----
const SLOT_TTL = 600;
async function acquire(userId: string, itemId: string): Promise<boolean> {
  const s = await getSettings();
  const u = await one<any>(pool, 'SELECT concurrency_override FROM users WHERE id=$1', [userId]);
  const userMax = u?.concurrency_override ?? s.concurrency_user;
  const now = Date.now();
  const res = await redis.eval(`
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
    redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, ARGV[1])
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
    if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 0 end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[5])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[5])
    return 1`, 2, `conc:user:${userId}`, 'conc:global', now - SLOT_TTL * 1000, now, userMax, s.concurrency_global, itemId);
  return res === 1;
}
async function release(userId: string, itemId: string) {
  await redis.multi().zrem(`conc:user:${userId}`, itemId).zrem('conc:global', itemId).exec();
}

// ---- simple circuit breaker per real model ----
async function breakerOpen(realModelId: string) { return (await redis.exists(`cb:open:${realModelId}`)) === 1; }
/** `final` = this candidate is being given up on; a quota error only opens the breaker then (after its own retries). */
async function recordFailure(realModelId: string, cls: string, final = true) {
  if (cls === 'prompt' || cls === 'invalid') return; // caller's fault, not the upstream's
  const k = `cb:fail:${realModelId}`;
  const n = await redis.multi().incr(k).expire(k, 60).exec();
  const count = Number(n?.[0]?.[1] ?? 0);
  if ((cls === 'quota' && final) || count >= 5) await redis.set(`cb:open:${realModelId}`, '1', 'EX', cls === 'quota' ? 30 : 60);
}

async function finishJob(jobId: string) {
  const r = await one<any>(pool, `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS pending,
    count(*) FILTER (WHERE status='succeeded')::int AS ok, count(*)::int AS total FROM job_items WHERE job_id=$1`, [jobId]);
  if (r.pending > 0) {
    await pool.query(`UPDATE jobs SET status='running' WHERE id=$1 AND status='queued'`, [jobId]);
    return;
  }
  const status = r.ok === r.total ? 'done' : r.ok === 0 ? 'failed' : 'partial';
  await pool.query('UPDATE jobs SET status=$2, finished_at=now() WHERE id=$1', [jobId, status]);
  const cover = await one<any>(pool, `SELECT i.output_asset_id, j.project_id FROM job_items i JOIN jobs j ON j.id=i.job_id
    WHERE i.job_id=$1 AND i.status='succeeded' ORDER BY i.idx LIMIT 1`, [jobId]);
  if (cover) await pool.query('UPDATE projects SET cover_asset_id=$2, updated_at=now() WHERE id=$1', [cover.project_id, cover.output_asset_id]);
}

async function refund(item: any, amount: number, note: string) {
  if (amount <= 0) return;
  await tx(async (c) => {
    await changeCredits(c, { userId: item.user_id, delta: amount, reason: 'refund', jobId: item.job_id, itemId: item.id, note });
    await c.query('UPDATE jobs SET refunded_credits = refunded_credits + $2 WHERE id=$1', [item.job_id, amount]);
  });
}

async function saveOutput(img: Awaited<ReturnType<typeof sanitizeOutput>>, o: { itemId: string; userId: string; projectId: string; usedModel: string; realModelId: string | null;
  quality: string; attempts: number; fallback: boolean; cost: number; ms: number; note: string | null; qc: any }) {
  const assetId = randomUUID();
  const key = `outputs/${o.userId}/${assetId}.${img.ext}`;
  await putObject(key, img.data, img.mime);
  await putObject(`thumbs/${o.userId}/${assetId}.webp`, await thumbnail(img.data), 'image/webp');
  await pool.query(`INSERT INTO assets(id, user_id, project_id, kind, storage_key, mime, width, height, bytes, sha256)
    VALUES ($1,$2,$3,'output',$4,$5,$6,$7,$8,$9)`, [assetId, o.userId, o.projectId, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
  await pool.query(`UPDATE job_items SET status='succeeded', output_asset_id=$2, used_model=$3, real_model_id=$4, used_quality=$5,
    attempts=$6, fallback=$7, cost_fen=$8, upstream_ms=$9, error_code=$10, qc=$11, finished_at=now() WHERE id=$1`,
    [o.itemId, assetId, o.usedModel, o.realModelId, o.quality, o.attempts, o.fallback, o.cost, o.ms, o.note, o.qc ? JSON.stringify(o.qc) : null]);
}

async function handleItem(job: Job<Data>, token?: string) {
  const { itemId, userId } = job.data;
  const item = await one<any>(pool, 'SELECT * FROM job_items WHERE id=$1 AND user_id=$2', [itemId, userId]);
  if (!item || item.status !== 'queued') return; // idempotent: already handled

  if (!(await acquire(userId, itemId))) {
    await job.moveToDelayed(Date.now() + 1500 + Math.random() * 1500, token);
    throw new DelayedError();
  }
  try {
    await pool.query(`UPDATE job_items SET status='running', started_at=now() WHERE id=$1`, [itemId]);
    await pool.query(`UPDATE jobs SET status='running' WHERE id=$1 AND status='queued'`, [item.job_id]);
    const jobRow = await one<any>(pool, 'SELECT * FROM jobs WHERE id=$1', [item.job_id]);
    const inputs = await many<any>(pool, `SELECT ji.role, a.id AS asset_id, a.storage_key, a.mime FROM job_inputs ji JOIN assets a ON a.id=ji.asset_id
      WHERE ji.job_id=$1 AND a.user_id=$2 ORDER BY ji.position`, [item.job_id, userId]);
    const refs = await Promise.all(inputs.map(async (x) => ({ role: x.role as string, assetId: x.asset_id as string, data: await getObject(x.storage_key), mime: x.mime as string })));
    const total = await one<any>(pool, 'SELECT count(*)::int AS n FROM job_items WHERE job_id=$1', [item.job_id]);
    const wantHd = jobRow.quality === 'hd';

    // Planner (one cached plan per job). Any failure → null → template prompt. Template and edit jobs skip the planner.
    const isEdit = jobRow.kind === 'edit';
    const fromTemplate = !isEdit && typeof jobRow.template_scene === 'string' && jobRow.template_scene.length > 0;
    const shots = Array.isArray(jobRow.shots) ? jobRow.shots : null;
    const facts = jobRow.facts && typeof jobRow.facts === 'object' ? jobRow.facts : null;
    const brand = jobRow.brand && typeof jobRow.brand === 'object' ? jobRow.brand : null;
    const sceneTag = !isEdit && !fromTemplate ? sceneForShot(jobRow.tags ?? [], item.idx, shots).tag : null;
    const selling = isTextTag(sceneTag);
    const planRec = fromTemplate || isEdit ? null : await getPlan(item.job_id, userId).catch((e) => { console.error('planner', item.job_id, String(e?.message ?? e).slice(0, 200)); return null; });
    if (planRec?.status === 'blocked') {
      await pool.query(`UPDATE job_items SET status='failed', error_code='content_blocked', error_message=$2, finished_at=now() WHERE id=$1`,
        [itemId, `planner: ${planRec.plan?.block_reason || 'content policy'}`.slice(0, 300)]);
      await refund(item, item.credits, 'content_blocked');
      return;
    }
    const plan = planRec?.status === 'ok' ? planRec.plan : undefined;
    const itemPlan = plan?.items.find((x) => x.index === item.idx);
    const editOp: EditOp = (EDIT_OPS as readonly string[]).includes(jobRow.edit_op) ? jobRow.edit_op : 'free';
    const promptFor = (sent: { role: string }[], droppedStyle: boolean) => isEdit
      ? buildEditPrompt({ op: editOp, text: jobRow.edit_text ?? '', ratio: item.ratio, refs: sent })
      : fromTemplate
      ? buildTemplatePrompt({ scene: jobRow.template_scene, allowText: !!jobRow.template_text, userText: jobRow.prompt, ratio: item.ratio,
          inputs: sent, index: item.idx, total: total.n, droppedStyle })
      : (plan && itemPlan)
      ? composePlannedPrompt({ styleLock: plan.style_lock, itemPrompt: itemPlan.prompt, ratio: item.ratio, refs: sent, total: total.n,
          product: plan.product, negative: plan.negative, styleSummary: plan.style_reference_summary, droppedStyle,
          lockedStyle: jobRow.style_lock, shot: shots?.[item.idx] ?? null, facts, selling, tag: sceneTag, brand })
      : buildPrompt({ userText: jobRow.prompt, tags: jobRow.tags, ratio: item.ratio, inputs: sent, index: item.idx, total: total.n,
          category: plan?.product.category, droppedStyle, shots, facts, styleLock: jobRow.style_lock, brand });
    const promptSrc = isEdit ? `prompt=edit:${editOp}` : fromTemplate ? 'prompt=tpl' : plan && itemPlan ? 'prompt=planner' : 'prompt=template';
    const toImages = (sent: typeof refs) => sent.map((x, i) => ({ data: x.data, mime: x.mime, name: `ref${i + 1}.${x.mime === 'image/png' ? 'png' : 'jpg'}` }));

    // Cut-outs (白底 / 透明底) are done locally when the photo holds one clear subject: the product pixels stay the photo's own.
    if (isEdit && (editOp === 'cutout' || editOp === 'matte') && mattingAvailable()) {
      const base = refs.find((r) => r.role === 'base');
      const t0 = Date.now();
      const local = base ? await cutoutImage(base.data, { transparent: editOp === 'matte', ratio: item.ratio }).catch((e) => { console.error('cutout', itemId, e?.message); return null; }) : null;
      if (local) {
        const img = await sanitizeOutput(local);
        await saveOutput(img, { itemId, userId, projectId: jobRow.project_id, usedModel: 'local', realModelId: null, quality: 'standard', attempts: 0, fallback: false, cost: 0, ms: Date.now() - t0, note: `local_${editOp}`, qc: null });
        return;
      }
      if (editOp === 'matte') {
        await pool.query(`UPDATE job_items SET status='failed', error_code='invalid', error_message='透明底只适合单个商品的图片，这张图里有多个物体', finished_at=now() WHERE id=$1`, [itemId]);
        await refund(item, item.credits, 'failed');
        return;
      }
    }
    const pasteOn = !isEdit && !NO_PASTE_TAGS.has(sceneTag ?? '') && mattingAvailable() && (await getSettings()).fidelity_enabled;
    const productRefs = refs.filter((r) => r.role === 'product').slice(0, 3);

    // Candidates: the planned platform model, then the rule's fallback. Candidates that take every reference go first;
    // a candidate with a lower max_refs is tried afterwards with references trimmed by priority product > model > style.
    const requeues = job.data.quotaRequeues ?? 0;
    const quotaExhausted = requeues >= QUOTA_REQUEUES;
    const order = [item.planned_model, job.data.primaryModel, job.data.fallbackModel, quotaExhausted ? LAST_RESORT_MODEL : null]
      .filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
    interface Attempt { platformKey: string; mi: number; cand: Candidate; sent: typeof refs; note: string | null; droppedStyle: boolean }
    const fit: Attempt[] = [];
    const trimmed: Attempt[] = [];
    for (const [mi, platformKey] of order.entries()) {
      for (const cand of await candidatesFor(platformKey)) {
        const caps = cand.caps || {};
        if (refs.length && caps.edit === false) continue;
        if (caps.ratios && !caps.ratios.includes(item.ratio)) continue;
        const max = caps.max_refs ?? 0;
        if (refs.length > max) {
          if (max < 1) continue;
          const t = trimRefs(refs, max);
          trimmed.push({ platformKey, mi, cand, sent: t.kept, droppedStyle: t.droppedStyle, note: t.droppedStyle ? 'fallback_drop_style' : 'fallback_trim_refs' });
        } else fit.push({ platformKey, mi, cand, sent: refs, droppedStyle: false, note: null });
      }
    }

    // Auto QC: product photos the result is compared against (originals, never the edited base).
    const qcProducts = refs.filter((r) => PRODUCT_ROLES.includes(r.role)).map((r) => r.data);
    const allowedText = selling ? [facts?.name ?? '', ...((facts?.points ?? []) as string[]), facts?.printed?.name ?? '', ...((facts?.printed?.points ?? []) as string[])].filter(Boolean)
      : fromTemplate ? Object.values((jobRow.template_fields ?? {}) as Record<string, string>) : [];
    let qcRetried = false;
    let qc: QcResult | null = null;
    let lastErr: UpstreamError | null = null;
    let lastNote: string | null = null;
    let contentRefused = false;
    let attempts = 0;
    for (const at of [...fit, ...trimmed]) {
      const { cand, platformKey } = at;
      if (at.note && contentRefused) continue; // a content refusal is not fixed by dropping a reference
      if (await breakerOpen(cand.real_model_id)) continue;
      const caps = cand.caps || {};
      const hd = wantHd && !!caps.hd;
      const prompt = promptFor(at.sent, at.droppedStyle);
      const images = toImages(at.sent);
      const logNote = [at.note, promptSrc].filter(Boolean).join(' ');
      // Same-candidate retries: quota/429 ("no available image quota") → back off 3–5s, up to 2 retries;
      // other retryable errors → 1 retry; invalid/fatal/prompt → none. Then move on to the next candidate.
      for (let retry = 0; ; retry++) {
        attempts++;
        lastNote = at.note;
        const t0 = Date.now();
        try {
          const out = await generate({
            vendor: cand.vendor, baseUrl: cand.base_url, apiKey: decryptSecret(cand.api_key_enc, cand.key_version),
            model: cand.model_id, timeoutMs: cand.timeout_ms, prompt, ratio: item.ratio, hd, images,
          });
          const ms = Date.now() - t0;
          let img = await sanitizeOutput(out.data);
          let pasted = 0;
          if (pasteOn && productRefs.length) {
            for (const pr of productRefs) {
              try {
                const piece = await pieceFor(pr.assetId, pr.data);
                const r = piece ? await pasteBack(piece, img.data) : null;
                if (r) { img = await sanitizeOutput(r.data); pasted++; }
              } catch (e: any) { console.error('pasteback', itemId, String(e?.message ?? e).slice(0, 200)); }
            }
          }
          // QC skipped for upscale (same content) and when nothing to compare; one free re-generation on a clear failure.
          if (!isEdit || editOp === 'erase' || editOp === 'expand' || editOp === 'cutout' || editOp === 'pose') {
            qc = await qcCheck(qcProducts, img.data, allowedText).catch(() => null);
            if (qc && !qc.pass && !qcRetried) {
              qcRetried = true;
              await pool.query('INSERT INTO upstream_call_logs(item_id, real_model_id, status_code, ms, note) VALUES ($1,$2,$3,$4,$5)',
                [itemId, cand.real_model_id, out.status, ms, `qc_fail:${qc.issues.join(',')} ${logNote}`.slice(0, 200)]);
              retry--; // a QC redo does not use the error-retry budget
              continue;
            }
          }
          const assetId = randomUUID();
          const key = `outputs/${userId}/${assetId}.${img.ext}`;
          await putObject(key, img.data, img.mime);
          await putObject(`thumbs/${userId}/${assetId}.webp`, await thumbnail(img.data), 'image/webp');
          await pool.query(`INSERT INTO assets(id, user_id, project_id, kind, storage_key, mime, width, height, bytes, sha256)
            VALUES ($1,$2,$3,'output',$4,$5,$6,$7,$8,$9)`, [assetId, userId, jobRow.project_id, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
          const usedQuality = hd ? 'hd' : 'standard';
          const cost = hd ? cand.cost_hd_fen : cand.cost_standard_fen;
          // error_code on a succeeded item is an internal note only (users see `error` just for failed items).
          await pool.query(`UPDATE job_items SET status='succeeded', output_asset_id=$2, used_model=$3, real_model_id=$4, used_quality=$5,
            attempts=$6, fallback=$7, cost_fen=$8, upstream_ms=$9, error_code=$10, qc=$11, finished_at=now() WHERE id=$1`,
            [itemId, assetId, platformKey, cand.real_model_id, usedQuality, attempts, at.mi > 0 || !!at.note, cost, ms, at.note,
              qc ? JSON.stringify({ ...qc, retried: qcRetried, ...(pasted ? { fidelity: pasted } : {}) }) : pasted ? JSON.stringify({ pass: true, issues: [], fidelity: pasted }) : null]);
          await pool.query('INSERT INTO upstream_call_logs(item_id, real_model_id, status_code, ms, note) VALUES ($1,$2,$3,$4,$5)', [itemId, cand.real_model_id, out.status, ms, pasted ? `${logNote} pasteback:${pasted}` : logNote]);
          // HD requested but served at standard: refund the difference.
          if (wantHd && !hd) {
            const std = jobRow.unit_price_standard ?? (await getPrices()).standard;
            await refund(item, Math.max(0, item.credits - std), 'hd_downgrade');
          }
          return;
        } catch (e: any) {
          if (e instanceof DelayedError) throw e;
          const err = e instanceof UpstreamError ? e : new UpstreamError('retryable', null, String(e?.message ?? e).slice(0, 200));
          lastErr = err;
          if (err.cls === 'prompt') contentRefused = true;
          await pool.query('INSERT INTO upstream_call_logs(item_id, real_model_id, status_code, error_class, ms, note) VALUES ($1,$2,$3,$4,$5,$6)',
            [itemId, cand.real_model_id, err.status, err.cls, Date.now() - t0, logNote]);
          // Grok quota → back of the queue (no in-process retry), until the requeue budget is spent; then move on (GPT).
          if (err.cls === 'quota' && platformKey === REQUEUE_MODEL && !quotaExhausted) {
            await pool.query(`UPDATE job_items SET status='queued', started_at=NULL, attempts=$2 WHERE id=$1`, [itemId, attempts]);
            await job.updateData({ ...job.data, quotaRequeues: requeues + 1 });
            await job.moveToDelayed(Date.now() + 4000 * (requeues + 1) + Math.random() * 2000, token);
            throw new DelayedError();
          }
          if (err.cls === 'quota' && platformKey === REQUEUE_MODEL) { await recordFailure(cand.real_model_id, err.cls, false); break; }
          const canRetry = err.cls === 'quota' ? retry < 2 : err.cls === 'retryable' && retry < 1;
          await recordFailure(cand.real_model_id, err.cls, !canRetry);
          if (!canRetry) break; // don't hammer on invalid/fatal/prompt, or past the retry budget
          if (err.cls === 'quota') await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
          if (await breakerOpen(cand.real_model_id)) break;
        }
      }
    }
    // Everything failed: mark and refund in full.
    await pool.query(`UPDATE job_items SET status='failed', attempts=$2, error_code=$3, error_message=$4, finished_at=now() WHERE id=$1`,
      [itemId, attempts, lastErr?.cls ?? 'no_route', `${lastNote ? `[${lastNote}] ` : ''}${lastErr?.message ?? 'no available model'}`.slice(0, 300)]);
    await refund(item, item.credits, 'failed');
  } catch (e: any) {
    if (e instanceof DelayedError) throw e; // requeued (quota): slot released in finally, item stays queued
    // Unexpected internal error: never keep the user's credits.
    const cur = await one<any>(pool, 'SELECT status FROM job_items WHERE id=$1', [itemId]);
    if (cur?.status === 'running') {
      await pool.query(`UPDATE job_items SET status='failed', error_code='internal', error_message=$2, finished_at=now() WHERE id=$1`, [itemId, String(e?.message ?? e).slice(0, 300)]);
      await refund(item, item.credits, 'internal_error');
    }
    console.error('item failed', itemId, e);
  } finally {
    await release(userId, itemId);
    await finishJob(item.job_id).catch((e) => console.error('finishJob', e));
  }
}

/** On boot, anything left 'running' by a crashed worker is failed and refunded. */
async function recoverStale() {
  const stale = await many<any>(pool, `SELECT * FROM job_items WHERE status='running' AND started_at < now() - interval '15 minutes'`);
  for (const it of stale) {
    const r = await pool.query(`UPDATE job_items SET status='failed', error_code='stale', finished_at=now() WHERE id=$1 AND status='running'`, [it.id]);
    if (r.rowCount) { await refund(it, it.credits, 'stale'); await finishJob(it.job_id); }
  }
}

const s = await getSettings();
await recoverStale();
setInterval(() => recoverStale().catch(console.error), 5 * 60_000);
const worker = new Worker<Data>(QUEUE, handleItem, { connection: connection(), concurrency: Math.max(4, s.concurrency_global + 4), lockDuration: 360_000 });
worker.on('failed', (j, e) => { if (!(e instanceof DelayedError)) console.error('job failed', j?.id, e?.message); });
console.log('worker started');
const stop = async () => { await worker.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

import { config } from '../config.js';
import { redis } from '../queue.js';

export type AlertType = 'upstream_failure_rate' | 'circuit_open' | 'cron_failed' | (string & {});

const RATE_LIMIT_S = 30 * 60;

/** Build a payload the target understands: 飞书/Lark, 企业微信, 钉钉, Discord, Slack, else a generic JSON body. */
function payload(url: string, title: string, text: string, type: string) {
  const host = new URL(url).hostname;
  const msg = `【Lumi 告警】${title}\n${text}`;
  if (/(^|\.)(feishu\.cn|larksuite\.com)$/.test(host)) return { msg_type: 'text', content: { text: msg } };
  if (host === 'qyapi.weixin.qq.com') return { msgtype: 'text', text: { content: msg } };
  if (host === 'oapi.dingtalk.com') return { msgtype: 'text', text: { content: msg } };
  if (/(^|\.)discord(app)?\.com$/.test(host)) return { content: msg.slice(0, 1900) };
  if (host === 'hooks.slack.com') return { text: msg };
  return { type, title, text, message: msg, service: 'lumi', at: new Date().toISOString() };
}

/**
 * Send an ops alert to ALERT_WEBHOOK_URL. At most one per `type` per 30 minutes (Redis SET NX).
 * Never throws; returns whether a webhook call was made successfully.
 */
export async function sendAlert(type: AlertType, title: string, text: string): Promise<boolean> {
  try {
    const ok = await redis.set(`alert:rl:${type}`, String(Date.now()), 'EX', RATE_LIMIT_S, 'NX');
    if (ok !== 'OK') return false; // already alerted for this type recently
  } catch { /* Redis down: still try to alert */ }
  console.warn(`[alert] ${type}: ${title} — ${text.replace(/\n/g, ' | ')}`);
  const url = config.ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(url, title, text, type)), signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[alert] webhook returned ${res.status}`);
    return res.ok;
  } catch (e: any) {
    console.error('[alert] webhook failed:', e?.message ?? e);
    return false;
  }
}

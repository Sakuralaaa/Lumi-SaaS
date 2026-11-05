import { fetch, FormData } from 'undici';
import { upstreamDispatcher, assertSafeUpstreamUrl } from '../../lib/ssrf.js';
import { config } from '../../config.js';

export type ErrorClass = 'retryable' | 'quota' | 'prompt' | 'invalid' | 'fatal';
export class UpstreamError extends Error {
  constructor(public cls: ErrorClass, public status: number | null, message: string) { super(message); }
}

export interface GenRequest {
  vendor: string; baseUrl: string; apiKey: string; model: string; timeoutMs: number;
  prompt: string; ratio: string; hd: boolean; images: { data: Buffer; mime: string; name: string }[];
}
export interface GenResult { data: Buffer; status: number }

const MAX_OUT = 40 * 1024 * 1024;

function classify(status: number, body: string): ErrorClass {
  const b = body.toLowerCase();
  if (status === 429 || b.includes('quota') || b.includes('额度')) return 'quota';
  if (b.includes('image_generation_text_response') || b.includes('content_policy') || b.includes('moderation') || b.includes('safety')) return 'prompt';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 401 || status === 403 || status === 404) return 'fatal';
  return 'retryable';
}

async function readImage(json: any): Promise<Buffer> {
  const d = json?.data?.[0];
  if (d?.b64_json) {
    const buf = Buffer.from(String(d.b64_json), 'base64');
    if (buf.length > MAX_OUT) throw new UpstreamError('retryable', 200, 'output too large');
    return buf;
  }
  if (d?.url) {
    // Upstream-provided URL: validate it like any untrusted URL before fetching.
    const u = await assertSafeUpstreamUrl(String(d.url)).catch(() => { throw new UpstreamError('retryable', 200, 'unsafe output url'); });
    const r = await fetch(u, { dispatcher: upstreamDispatcher(), signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new UpstreamError('retryable', r.status, 'output download failed');
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_OUT) throw new UpstreamError('retryable', 200, 'output too large');
    return Buffer.from(ab);
  }
  if (json?.output_type === 'text' || typeof json?.text === 'string') throw new UpstreamError('prompt', 200, 'upstream returned text');
  throw new UpstreamError('retryable', 200, 'no image in response');
}

export async function generate(req: GenRequest): Promise<GenResult> {
  const base = req.baseUrl.replace(/\/+$/, '');
  if (config.UPSTREAM_USE_ENV_PROXY) await assertSafeUpstreamUrl(base); // proxy mode skips connect-time guard
  const headers = { Authorization: `Bearer ${req.apiKey}`, Accept: 'application/json' };
  const signal = AbortSignal.timeout(req.timeoutMs);
  let res;
  try {
    if (req.images.length) {
      const fd = new FormData();
      fd.set('model', req.model);
      fd.set('prompt', req.prompt);
      fd.set('n', '1');
      fd.set('response_format', 'b64_json');
      const field = req.vendor === 'grok2api' ? 'image' : 'image[]';
      for (const im of req.images) fd.append(field, new Blob([new Uint8Array(im.data)], { type: im.mime }), im.name);
      if (req.vendor === 'grok2api') {
        fd.set('aspect_ratio', req.ratio);
        if (req.hd) fd.set('resolution', '2k');
      } else fd.set('size', req.ratio);
      res = await fetch(`${base}/images/edits`, { method: 'POST', headers, body: fd, dispatcher: upstreamDispatcher(), signal });
    } else {
      const body: any = { model: req.model, prompt: req.prompt, n: 1, response_format: 'b64_json' };
      if (req.vendor === 'grok2api') { body.aspect_ratio = req.ratio; if (req.hd) body.resolution = '2k'; }
      else body.size = req.ratio;
      res = await fetch(`${base}/images/generations`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), dispatcher: upstreamDispatcher(), signal,
      });
    }
  } catch (e: any) {
    throw new UpstreamError('retryable', null, e?.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(classify(res.status, text), res.status, text.slice(0, 300));
  let json: any;
  try { json = JSON.parse(text); } catch { throw new UpstreamError('retryable', res.status, 'invalid json'); }
  if (json?.error) throw new UpstreamError(classify(res.status, JSON.stringify(json.error)), res.status, JSON.stringify(json.error).slice(0, 300));
  return { data: await readImage(json), status: res.status };
}

export async function listModels(a: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const base = (await assertSafeUpstreamUrl(a.baseUrl.replace(/\/+$/, ''))).toString().replace(/\/+$/, '');
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${a.apiKey}` }, dispatcher: upstreamDispatcher(), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`上游返回 ${r.status}`);
  const j: any = await r.json();
  return (j?.data ?? []).map((m: any) => String(m.id)).filter((s: string) => s.length < 200);
}

export const isImageModel = (id: string) => /image|imagine|dall-e/i.test(id) && !/video/i.test(id);
/** Text/vision chat models usable by the planner (excludes image/video/audio-only ids). */
export const isChatModel = (id: string) => !isImageModel(id) && !/video|voice|stt|tts|whisper|audio|embed|moderation|dall-e/i.test(id) && id !== 'auto';

/**
 * The single fetch wrapper for the whole app.
 * - same-origin credentials only (session lives in an httpOnly cookie; nothing is kept in localStorage)
 * - every non-GET request carries `X-Requested-With: lumi` (server CSRF guard) and a JSON body (`{}` when empty)
 * - 401 on a protected call sends the user to /login
 * - errors surface the server's Chinese `message`
 */

export class ApiError extends Error {
  status: number;
  code: string;
  /** true when the client is already navigating to /login because of this error */
  redirected = false;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const AUTH_PATHS = ['/api/auth/login', '/api/auth/register', '/api/auth/password'];

function redirectToLogin() {
  const p = window.location.pathname;
  if (p === '/login' || p === '/register') return;
  const next = encodeURIComponent(p + window.location.search);
  window.location.assign(`/login?next=${next}`);
}

export interface RequestOpts {
  /** extra request headers, e.g. `Idempotency-Key` */
  headers?: Record<string, string>;
}

/** Listeners notified when any call is refused with 403 `must_change_password`. */
const mustChangeListeners = new Set<() => void>();
export function onMustChangePassword(fn: () => void) {
  mustChangeListeners.add(fn);
  return () => { mustChangeListeners.delete(fn); };
}

async function request<T>(method: Method, path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      // never let callers override the CSRF / content headers set below
      if (!/^(x-requested-with|content-type|cookie)$/i.test(k)) headers[k] = v;
    }
  }
  const init: RequestInit = { method, credentials: 'same-origin', headers, cache: 'no-store' };
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'lumi';
    if (body instanceof FormData) {
      init.body = body; // browser sets the multipart boundary
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', '网络连接失败，请检查网络后重试');
  }

  let data: any = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    const message = typeof data?.message === 'string' && data.message ? data.message : defaultMessage(res.status);
    const code = typeof data?.error === 'string' ? data.error : 'error';
    const err = new ApiError(res.status, code, message);
    if (res.status === 401 && !AUTH_PATHS.includes(path)) { err.redirected = true; redirectToLogin(); }
    if (res.status === 403 && code === 'must_change_password') mustChangeListeners.forEach((fn) => fn());
    throw err;
  }
  return data as T;
}

function defaultMessage(status: number) {
  if (status === 401) return '请先登录';
  if (status === 403) return '没有权限';
  if (status === 404) return '内容不存在';
  if (status === 409) return '操作冲突，请刷新后重试';
  if (status === 410) return '内容已过期';
  if (status === 413) return '文件过大，最大 15MB';
  if (status === 429) return '操作太频繁，请稍后再试';
  if (status >= 500) return '服务器开小差了，请稍后再试';
  return '请求失败';
}

function qs(params?: Record<string, string | number | undefined | null>) {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | number | undefined | null>) => request<T>('GET', path + qs(params)),
  post: <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>('PATCH', path, body, opts),
  del: <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>('DELETE', path, body, opts),
  upload: <T>(path: string, file: File, opts?: RequestOpts) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<T>('POST', path, fd, opts);
  },
};

/** Only allow URLs that are same-origin paths or https — signed image URLs come from the server. */
export function safeUrl(u: string | null | undefined): string | undefined {
  if (!u || typeof u !== 'string') return undefined;
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  try {
    const p = new URL(u, window.location.origin);
    if (p.protocol === 'https:' || p.origin === window.location.origin) return p.toString();
  } catch { /* ignore */ }
  return undefined;
}

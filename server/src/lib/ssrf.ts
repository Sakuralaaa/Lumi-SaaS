import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';
import dns from 'node:dns';
import { config } from '../config.js';

function v4ToInt(ip: string) { return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
const V4_BLOCK: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCK.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
}

/** Validates an admin-entered upstream base URL. Throws with a user-safe message. */
export async function assertSafeUpstreamUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('地址格式不正确'); }
  if (u.username || u.password) throw new Error('地址里不能带账号密码');
  if (u.protocol !== 'https:' && !(config.UPSTREAM_ALLOW_PRIVATE && u.protocol === 'http:')) throw new Error('只允许 https 地址');
  if (u.hash || u.search) throw new Error('地址不能带查询参数');
  if (!config.UPSTREAM_ALLOW_PRIVATE) {
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error('域名无法解析');
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('不允许内网地址');
  }
  return u;
}

/** Dispatcher whose DNS lookup refuses private addresses (blocks DNS rebinding at connect time). */
function guardedLookup(hostname: string, opts: any, cb: any) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs: any) => {
    if (err) return cb(err);
    const list = (addrs as { address: string; family: number }[]);
    if (!config.UPSTREAM_ALLOW_PRIVATE && list.some((a) => isPrivateIp(a.address))) return cb(new Error('blocked private address'));
    if (opts?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

let dispatcher: Dispatcher | null = null;
export function upstreamDispatcher(): Dispatcher {
  if (dispatcher) return dispatcher;
  dispatcher = config.UPSTREAM_USE_ENV_PROXY
    ? new EnvHttpProxyAgent()
    : new Agent({ connect: { lookup: guardedLookup as any }, headersTimeout: 330_000, bodyTimeout: 330_000 });
  return dispatcher;
}

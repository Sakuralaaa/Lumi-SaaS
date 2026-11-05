import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, isProd } from './config.js';
import { registerAuth } from './auth.js';
import { HttpError } from './lib/errors.js';
import { getObject, verifyLocalSignature } from './lib/storage.js';
import { redis } from './queue.js';
import authRoutes from './routes/auth.js';
import workRoutes from './routes/work.js';
import adminRoutes from './routes/admin.js';
import libraryRoutes from './routes/library.js';
import extrasRoutes from './routes/extras.js';
import designRoutes from './routes/design.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: isProd ? 'info' : 'warn', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    // Hop count n → trust the n closest proxies (e.g. 1 = Caddy); req.ip is then the client Caddy saw.
    trustProxy: typeof config.TRUST_PROXY === 'number' ? ((_addr: string, i: number) => i < (config.TRUST_PROXY as number)) : config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...(config.S3_ENDPOINT ? [new URL(config.S3_ENDPOINT).origin] : []), 'https:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute', redis,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited', message: '操作太频繁，请稍后再试' }),
  });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2, parts: 3 } });

  registerAuth(app);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', message: err.issues[0]?.message ?? '参数不正确' });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: '操作太频繁，请稍后再试' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: '请求不正确' });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: '服务器开小差了，请稍后再试' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(workRoutes);
  await app.register(adminRoutes);
  await app.register(libraryRoutes);
  await app.register(extrasRoutes);
  await app.register(designRoutes);

  // Local storage: signed, expiring URLs only.
  app.get('/files/*', async (req, reply) => {
    const key = (req.params as any)['*'] as string;
    const q = req.query as Record<string, string>;
    if (!verifyLocalSignature(key, q.exp, q.dl, q.sig)) return reply.status(403).send({ error: 'forbidden' });
    const buf = await getObject(key).catch(() => null);
    if (!buf) return reply.status(404).send({ error: 'not_found' });
    const type = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=600').header('X-Content-Type-Options', 'nosniff');
    if (q.dl === '1') reply.header('Content-Disposition', `attachment; filename="lumi-${key.split('/').pop()}"`);
    return reply.send(buf);
  });

  // Serve the built web app (single origin keeps cookies first-party and CSRF simple).
  const dist = config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : null;
  if (dist && existsSync(dist)) {
    await app.register(fstatic, { root: dist, wildcard: false, maxAge: '1h' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/files/')) return reply.status(404).send({ error: 'not_found', message: '不存在' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

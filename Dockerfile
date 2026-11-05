# syntax=docker/dockerfile:1
#
# Lumi 出图 — one repo, three build targets:
#   runtime (default, last stage): Node image for api / worker / cron
#       api    : node server/dist/index.js     (runs DB migrations on boot, also serves web/dist)
#       worker : node server/dist/worker.js
#       cron   : node server/dist/cron.js
#     pick the role with the container command, or env APP_ROLE=api|worker|cron
#   caddy   : Caddy + the built web SPA in /srv (docker compose `caddy` service)
#
# Sources are copied selectively (no `COPY . .`) so host node_modules, data/, .env files,
# screenshots and tests never end up in the image even without a .dockerignore.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- build: compile server (tsc -> server/dist) and web (vite -> web/dist) ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# onnxruntime-node: CPU binaries are bundled; never fetch the optional CUDA provider (GBs, from NuGet).
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# vendor/: optional pre-downloaded npm tarballs (slow links); seeded into the npm cache so npm ci doesn't refetch them.
COPY vendor/ /tmp/vendor/
RUN for f in /tmp/vendor/*.tgz; do [ -f "$f" ] && npm cache add "$f"; done; npm ci --prefer-offline --fetch-retries=5 --no-audit --no-fund
COPY server/tsconfig.json server/
COPY server/src server/src
COPY web/index.html web/tsconfig.json web/vite.config.ts web/
COPY web/public web/public
COPY web/src web/src
RUN npm run build -w web \
 && npm run build -w server \
 && cp -r server/src/db/migrations server/dist/db/ \
 && test -f server/dist/index.js && test -f server/dist/worker.js && test -f server/dist/cron.js \
 && test -f server/dist/db/migrations/001_init.sql && test -f web/dist/index.html

# ---------- deps: production-only node_modules for the server workspace (no antd/react/vite) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY vendor/ /tmp/vendor/
RUN for f in /tmp/vendor/*.tgz; do [ -f "$f" ] && npm cache add "$f"; done; npm ci --prefer-offline --fetch-retries=5 --omit=dev -w server --no-audit --no-fund && npm cache clean --force && rm -rf /tmp/vendor

# ---------- caddy: reverse proxy + static SPA ----------
FROM caddy:2-alpine AS caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist /srv

# ---------- runtime (default target) ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/web/dist \
    STORAGE_LOCAL_DIR=/app/data/storage \
    PORT=8787 HOST=0.0.0.0
WORKDIR /app
RUN useradd -r -u 10001 -m -d /home/lumi lumi && mkdir -p /app/data/storage && chown -R lumi:lumi /app/data
COPY --from=deps  --chown=lumi:lumi /app/node_modules ./node_modules
COPY --from=build --chown=lumi:lumi /app/package.json ./
COPY --from=build --chown=lumi:lumi /app/server/package.json ./server/
COPY --from=build --chown=lumi:lumi /app/server/dist ./server/dist
COPY --from=build --chown=lumi:lumi /app/web/dist ./web/dist
# Local product matting model: IS-Net general-use (DIS, Apache-2.0), CPU, ~170 MB. Used by the worker for
# cut-outs and the product paste-back; when missing, those features switch off and the model-based path is used.
ADD --chown=lumi:lumi --checksum=sha256:60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a \
    https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx /app/models/isnet-general-use.onnx
USER lumi
EXPOSE 8787
# Role is chosen by the command (docker compose) or by APP_ROLE=api|worker|cron (PaaS such as Zeabur,
# where several services run this same image with only env differing). Default: api.
ENV APP_ROLE=api
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD [ "$APP_ROLE" != "api" ] || node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "case \"${APP_ROLE:-api}\" in api) exec node server/dist/index.js ;; worker) exec node server/dist/worker.js ;; cron) exec node server/dist/cron.js ;; *) echo \"unknown APP_ROLE=$APP_ROLE (api|worker|cron)\" >&2; exit 64 ;; esac"]

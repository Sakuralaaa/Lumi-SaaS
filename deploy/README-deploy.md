# Lumi 出图 · 生产部署手册

两种部署方式任选其一：

- **A. 自有 Linux 云服务器 + docker compose**（推荐，成本最低、可控性最好）
- **B. Zeabur**（免运维 PaaS，按量计费）

架构（方式 A）：

```
浏览器 ──443──> caddy（自动 HTTPS，静态前端 /srv，/api/* /files/* 反代）
                  └──> api:8787（Node，启动时自动跑数据库迁移）
                         ├── postgres:17（数据卷 pgdata，不暴露端口）
                         └── redis:7（AOF，数据卷 redisdata，不暴露端口）
                 worker（生图队列）、cron（过期清理 + 告警检查）与 api 共用同一镜像
```

只有 caddy 对外暴露 80/443，数据库和 Redis 只在容器内网可见。

---

## A. 云服务器部署（docker compose）

### 1. 买服务器

- 配置建议：**2 核 4 GB 起**（sharp 图片处理吃内存），系统 Ubuntu 22.04/24.04 或 Debian 12，硬盘 40 GB+（用本地存储图片时按量加大）。
- 面向国内用户且使用国内服务器：域名需要 **ICP 备案** 才能用 80/443。不想备案可选香港/新加坡等境外节点。
- 上游生图接口在海外时，境外服务器的连通性通常更稳定。

### 2. 域名解析

在域名服务商添加 **A 记录**：`app.example.com → 服务器公网 IP`（有 IPv6 再加 AAAA）。
等 `ping app.example.com` 解析到新 IP 后再启动，否则 Caddy 申请证书会失败（它会自动重试）。

### 3. 防火墙：只开 22 / 80 / 443

云厂商安全组：入站只放行 **22（建议仅你的 IP）、80、443（TCP）、443（UDP，HTTP/3 可选）**。服务器内：

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
```

> 注意：Docker 发布的端口会绕过 ufw。本项目只有 caddy 发布端口，所以没问题；**不要**给 postgres/redis/api 加 `ports:`。

### 4. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh        # 国内机器可加 --mirror Aliyun
sudo usermod -aG docker $USER && newgrp docker
docker compose version                              # 需要 v2
```

国内服务器拉镜像慢时，在 `/etc/docker/daemon.json` 配置镜像加速后 `sudo systemctl restart docker`。

### 5. 拉代码

```bash
sudo mkdir -p /opt/lumi && sudo chown $USER /opt/lumi
git clone <你的仓库地址> /opt/lumi
cd /opt/lumi            # 仓库根目录 = 含 Dockerfile / docker-compose.yml 的 app 目录
```

### 6. 填写 .env

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 24       # -> POSTGRES_PASSWORD（用 hex，避免特殊字符破坏连接串）
openssl rand -base64 48    # -> APP_SECRET（至少 32 字符）
openssl rand -base64 32    # -> MASTER_KEY（必须正好 32 字节 base64）
nano .env
```

必填：`DOMAIN`、`PUBLIC_ORIGIN=https://同一域名`、`POSTGRES_PASSWORD`、`APP_SECRET`、`MASTER_KEY`。
保持：`TRUST_PROXY=1`、`COOKIE_SECURE=true`、`UPSTREAM_ALLOW_PRIVATE=false`。
首次启动取消注释并填写 `ADMIN_EMAIL`、`ADMIN_PASSWORD`（≥12 位）。

> 生产模式下 API 会拒绝启动：弱密钥/占位符、`PUBLIC_ORIGIN` 非 https、`COOKIE_SECURE` 关闭。看 `docker compose logs api` 的报错逐项修正即可。
>
> **TRUST_PROXY 不要写 `true`**：`1` 表示只信任一跳（Caddy）。`true` 会信任整条 X-Forwarded-For 链，一旦代理配置变化，用户就能伪造 IP 绕过限流。

### 7. 启动

```bash
docker compose up -d --build
docker compose ps                 # api 状态应为 healthy
docker compose logs -f api        # 看到 "api listening on :8787"
```

打开 `https://你的域名`，Caddy 会自动申请并续期证书。

### 8. 首个管理员登录后：删除 ADMIN_PASSWORD

用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录确认无误后：

```bash
nano .env      # 删除或注释掉 ADMIN_PASSWORD（不要留空值 ADMIN_PASSWORD=，空值会校验失败）
docker compose up -d
```

### 9. ⚠️ 离线备份 MASTER_KEY

`MASTER_KEY` 用于加密数据库里保存的所有上游 API Key（AES-256-GCM）。
**丢失 MASTER_KEY = 所有已保存的上游 Key 永久无法解密**，数据库备份也救不回来。

- 抄到密码管理器（1Password / Bitwarden）+ 打印一份纸质存放，**不要**和数据库备份放在同一处。
- `.env` 整份也离线保存一份。
- 轮换：新 key 设为 `MASTER_KEY`、`MASTER_KEY_VERSION` +1，旧 key 写入 `MASTER_KEYS_OLD="1:旧key"`。

### 10. 每日数据库备份

`deploy/backup.sh`：`pg_dump` → gzip →（可选）age 加密 → 本地保留 14 份 →（可选）rclone 上传异地 → 失败时推送告警。

```bash
sudo apt install -y age rclone        # 可选：加密 / 异地上传
age-keygen -o lumi-backup-key.txt     # 在你自己的电脑上生成！私钥不要放服务器
#   把输出的公钥 age1... 填到 .env 的 AGE_RECIPIENT
rclone config                         # 可选：配置 R2/S3/OSS 远端，如名为 r2
#   .env: RCLONE_REMOTE=r2:lumi-backups/db
sudo mkdir -p /var/backups/lumi
sudo /opt/lumi/deploy/backup.sh       # 先手动跑一次，退出码 0 即成功
```

加入 root 的 crontab（`sudo crontab -e`），每天 03:30：

```cron
30 3 * * * /opt/lumi/deploy/backup.sh >> /var/log/lumi-backup.log 2>&1
```

退出码：0 成功 · 1 导出失败 · 2 配置/依赖缺失 · 3 加密失败 · 4 上传失败（本地副本保留）· 5 已有备份在运行。
使用本地存储（`STORAGE_DRIVER=local`）时，在 .env 加 `BACKUP_FILES=1` 一并打包图片卷（体积可能很大，更推荐改用 R2）。

### 11. 恢复演练（每月一次）

```bash
# 只恢复到临时库 lumi_restore_test 做校验，不影响线上，完成后自动删除
sudo deploy/restore.sh --test /var/backups/lumi/lumi-db-20260101-033000.dump.gz
# 加密备份需要私钥（临时拷到服务器，用完删除）
sudo AGE_IDENTITY=/root/lumi-backup-key.txt deploy/restore.sh --test /var/backups/lumi/xxx.dump.gz.age
```

真正恢复线上库（会停 api/worker/cron → 重建 lumi 库 → 恢复 → 重启，需要输入 `RESTORE` 确认）：

```bash
sudo deploy/restore.sh /var/backups/lumi/lumi-db-20260101-033000.dump.gz
```

换新服务器恢复：装 Docker → clone → 放回原 `.env`（**同一个 MASTER_KEY**）→ `docker compose up -d --build` → `restore.sh` 恢复最新备份。

### 12. 升级

```bash
cd /opt/lumi
sudo deploy/backup.sh               # 升级前先备份
git pull
docker compose up -d --build        # api 启动时自动执行新的数据库迁移
docker compose ps && docker compose logs --tail=100 api worker
docker image prune -f               # 清理旧镜像
```

回滚：`git checkout <上个版本>` 后再 `docker compose up -d --build`；如果新版本迁移改了表结构，需要用升级前的备份恢复。

### 13. 查看日志 / 常用命令

```bash
docker compose logs -f api            # API
docker compose logs -f worker         # 生图队列
docker compose logs -f cron           # 过期清理、告警检查
docker compose logs -f caddy          # 访问日志、证书
docker compose restart worker
docker compose exec postgres psql -U lumi lumi
docker stats                          # 资源占用
```

容器日志已限制为每个服务 5 × 10 MB 滚动，不会撑爆磁盘。

---

## 对象存储（S3 / Cloudflare R2）

默认 `STORAGE_DRIVER=local` 把图片存在 `appdata` 卷里，适合起步。正式运营建议改为 **私有** 对象存储：

1. Cloudflare R2 新建 bucket（如 `lumi`），**不要开启公共访问 / r2.dev 公开域名**；应用只下发短期签名 URL。
2. 创建 API Token：权限只给 **该 bucket 的 Object Read & Write**。
3. `.env`：
   ```
   STORAGE_DRIVER=s3
   S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_BUCKET=lumi
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_FORCE_PATH_STYLE=true
   ```
4. 如浏览器直接访问签名 URL，需在 bucket 的 CORS 里允许你的域名 `GET`。
5. 保留期由 `RETENTION_DAYS`（默认 30 天）控制，cron 服务自动删除过期图片；也可在 R2 加一条更长的生命周期规则兜底。
6. 从 local 切到 s3 不会自动迁移旧文件，旧图需要用 `rclone copy` 手动搬运，或等其自然过期。

也可用阿里云 OSS / 腾讯云 COS 的 S3 兼容端点，同样保持私有读写。

---

## 告警 Webhook（飞书 / 企业微信 / 钉钉）

在 `.env` 设置 `ALERT_WEBHOOK_URL`，API/cron 会在上游失败率过高、熔断打开、定时任务失败时推送；备份脚本失败也会推送。程序按域名自动适配消息格式，同类告警 30 分钟内只发一次。

- **飞书**：群设置 → 群机器人 → 添加「自定义机器人」→ 复制 `https://open.feishu.cn/open-apis/bot/v2/hook/...`。安全设置选「自定义关键词」，填 `Lumi`（消息以【Lumi 告警】开头）。不要选「签名校验」（暂不支持）。
- **企业微信**：群 → 添加群机器人 → 复制 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`。
- **钉钉**：群设置 → 智能群助手 → 添加机器人 → 自定义 → 安全设置选「自定义关键词」填 `Lumi` → 复制 `https://oapi.dingtalk.com/robot/send?access_token=...`。（「加签」模式暂不支持。）

改完 `docker compose up -d` 生效。

---

## B. Zeabur 部署

Zeabur 上不需要 Caddy：api 服务自己托管前端静态文件（镜像内 `WEB_DIST_DIR=/app/web/dist`），HTTPS 由 Zeabur 提供。

1. 新建项目（区域选离用户/上游接口近的，如香港、东京）。
2. **Add Service → Marketplace → PostgreSQL**，再添加 **Redis**。
3. **Add Service → GitHub → 选本仓库**，共添加 **3 次**，分别命名 `api`、`worker`、`cron`。Zeabur 检测到 `Dockerfile` 会直接用它构建（默认构建最后一个 stage `runtime`）。
   三个服务用同一镜像，通过环境变量 `APP_ROLE` 区分角色：
   | 服务 | APP_ROLE | 说明 |
   |---|---|---|
   | api | `api`（默认） | 对外端口 8787，绑定域名；启动时跑迁移 |
   | worker | `worker` | 不绑定域名 |
   | cron | `cron` | 不绑定域名，只跑 **1 个实例** |
   （也可以在服务设置里直接改启动命令为 `node server/dist/worker.js` / `node server/dist/cron.js`。）
4. 环境变量（三个服务都要配，可用 Zeabur 的共享变量）：
   - `DATABASE_URL`、`REDIS_URL`：引用 PostgreSQL / Redis 服务暴露的连接串变量（如 `${POSTGRES_CONNECTION_STRING}`、`${REDIS_CONNECTION_STRING}`，以控制台中实际显示的变量名为准）。
   - `NODE_ENV=production`、`PUBLIC_ORIGIN=https://你的域名`、`APP_SECRET`、`MASTER_KEY`、`COOKIE_SECURE=true`、`TRUST_PROXY=1`、`RETENTION_DAYS`、`ALERT_WEBHOOK_URL`。
   - 只在 api 上首次设置 `ADMIN_EMAIL` / `ADMIN_PASSWORD`，登录后删除。
5. **存储必须用 S3/R2**：Zeabur 的数据卷挂在单个服务上，api 和 worker 之间无法共享，`STORAGE_DRIVER=local` 会导致 worker 生成的图 api 读不到。按上文配置 R2 私有 bucket。
6. **绑定域名**：api 服务 → Networking/Domains → 先用免费 `xxx.zeabur.app` 测试；自定义域名按提示添加 CNAME 记录，证书自动签发。改域名后同步修改 `PUBLIC_ORIGIN`。
7. 备份：在 Zeabur PostgreSQL 服务开启自动备份；同时建议定期在本地用 `pg_dump "$DATABASE_URL"` 导出一份异地保存。`MASTER_KEY` 同样需要离线备份。
8. `TRUST_PROXY=1` 假设 Zeabur 入口只有一层代理；上线后到管理后台审计日志确认记录的是真实用户 IP，若显示的是内网地址，按实际跳数调整。

---

## 附：合规提醒

如果上游生图走的是第三方「中转 / 代理」服务，其条款常写明**仅限个人、非商业使用**，或未获得原模型厂商的转售授权。商业运营前请核对上游服务条款，优先使用官方 API 或有商用授权的渠道，避免账号被封或产生法律风险。

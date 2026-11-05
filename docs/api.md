# Lumi API (v0.1)

All endpoints are same-origin under `/api`. Auth is an httpOnly cookie set by login/register.

**Every non-GET request MUST send header `X-Requested-With: lumi`** (CSRF guard) and a JSON body (send `{}` when there is nothing). Errors: `{ error: code, message: 中文提示 }` with HTTP status. Show `message` to users.

Image URLs returned (`url`, `thumb`, `cover`) are short-lived signed URLs (~15 min). Re-fetch lists to refresh them; don't cache long.

### Common error codes
| HTTP | `error` | When |
|---|---|---|
| 400 | `validation` / `bad_request` / specific codes | bad input (`message` is user-facing) |
| 401 | `unauthorized` | not logged in / session revoked |
| 402 | `insufficient_credits` | not enough credits |
| 403 | `csrf` | missing `X-Requested-With: lumi` or foreign `Origin` |
| 403 | `forbidden` | non-admin on admin routes |
| 403 | `must_change_password` | account was reset by an admin; only `/api/auth/*`, `/api/me`, `/api/health` work until `POST /api/auth/password` succeeds. Show the change-password dialog. |
| 404 | `not_found` | missing **or not yours** (other users' objects are always 404, never 403) |
| 409 | `idempotency_conflict` / `idempotency_in_progress` | see Idempotency-Key below |
| 410 | `expired` | `GET /api/items/:id/download` on an image deleted by retention |
| 410 | `asset_expired` | `POST /api/jobs` with an input image deleted by retention (ask the user to re-upload) |
| 410 | `preview_expired` | `POST /api/models-library/ai/save` with an unknown/used/expired previewId |
| 429 | `rate_limited` / `daily_limit` / `locked` | rate limit, daily image cap, login lockout |

### Retention
Uploads and generated images are kept `RETENTION_DAYS` (default **30**) days, then their files are deleted (the row stays).
Every item / input view carries `expired: boolean` and `expiresAt: ISO | null` (when the file will be / was deleted).
When `expired` is true, `url`/`thumb` are `null` — show a placeholder (“已过期”). Model-library portraits and template covers never expire;
an upload that is an input of a job younger than the retention window is kept until that job ages out.

## Auth
- `POST /api/auth/register` `{email, password(>=8), inviteCode, displayName?}` → `{ok}` (logs in)
- `POST /api/auth/login` `{email, password}` → `{ok}`; 401 `invalid_login`; 429 `locked`
- `POST /api/auth/logout` `{}`
- `POST /api/auth/password` `{current, next(>=8, ≠ current)}` → `{ok}`. Revokes **all** sessions of the user and issues a fresh cookie for this browser; clears `mustChangePassword`. 400 if `current` is wrong, 400 `same_password`.
- `GET /api/me` → `{user: null | {id,email,display_name,role:'user'|'admin',credits,daily_limit,mustChangePassword:boolean}}`
  - `mustChangePassword: true` → force the change-password dialog (every other app API answers 403 `must_change_password`).

## Options
- `GET /api/options` → `{prices:{standard:2,hd:4}, ratios:['1:1','3:4','4:3','9:16','16:9'], tags:[...], maxImagesPerJob:8}`
  - tag keys → labels for UI: `white_bg` 白底主图, `scene` 场景图, `detail` 细节特写, `atmosphere` 氛围大片, `model_wear` 模特上身, `flat_lay` 平铺搭配, `street` 街拍, `festival` 节日促销
  - simple mode shows: white_bg, scene, detail, atmosphere, festival. detailed mode shows: model_wear, flat_lay, street, detail, scene, atmosphere

## Projects
- `GET /api/projects` → `[{id,name,mode:'simple'|'detailed',createdAt,updatedAt,cover|null}]` (sorted by updatedAt desc; group into 今天/本周/更早 in the sidebar)
- `POST /api/projects` `{name?, mode}` → `{id,name,mode,created_at}`
- `PATCH /api/projects/:id` `{name?, mode?}`
- `DELETE /api/projects/:id` `{}`

## Uploads
- `POST /api/uploads` multipart, single field `file` (jpg/png/webp/heic ≤15MB). NOTE: still send `X-Requested-With: lumi`; do not set Content-Type manually. → `{id,width,height,thumb}`

## Jobs (generation)
- `POST /api/jobs`
  ```
  { projectId, prompt (≤500, can be ''), tags: string[] (≤6),
    quality: 'standard'|'hd', ratios: string[] (1–4), perRatio: 1–4,
    inputs: [{assetId, role}] (≤5) }
  ```
  roles: `product` (simple mode), `top|bottom|shoes|bag|accessory` (detailed products, ≤3), `model` (my model photo), `style` (style reference, optional).
  cost = prices[quality] × ratios.length × perRatio; total images ≤ maxImagesPerJob.
  → `{id, items:[itemId], reserved}`; errors 402 `insufficient_credits`, 429 `daily_limit`, 410 `asset_expired`, 404 (input not yours).
  - **`Idempotency-Key: <uuid>` header (recommended; optional).** Generate one UUID per user click and reuse it on retries/double-clicks.
    - Same key + same body within 24 h → the original `{id, items, reserved}` is returned with response header `Idempotent-Replayed: true`; no new job, credits charged once (concurrent duplicates serialize; exactly one job is created).
    - Same key + different body → 409 `idempotency_conflict` (make a new key). Still being created → 409 `idempotency_in_progress` (retry shortly).
    - Not a UUID → 400 `bad_idempotency_key`. Body comparison ignores JSON key order. Keys expire after 24 h.
- `GET /api/jobs/:id` → `{id,status:'queued'|'running'|'done'|'partial'|'failed', credits(current balance), items:[Item]}` — poll every 3s while queued/running.
- `GET /api/projects/:id/jobs` → `[{id,status,quality,prompt,tags,ratios,perRatio,credits,createdAt,inputs:[{assetId,role,thumb}],items:[Item]}]` newest first.

Item: `{id, jobId, ratio, status:'queued'|'running'|'succeeded'|'failed', favorite, quality, error|null, width, height, url|null, thumb|null, expired, expiresAt|null}`
  - `error` (failed items only) is user-facing Chinese. A failure because the planner judged the request against content policy (internal code `content_blocked`) shows “描述内容不符合平台规范，积分已退回”; any other failure “生成失败，积分已退回”. Failed items are always refunded.
  - Project jobs `inputs[]` also carry `expired` (thumb `null` when expired).

- `POST /api/items/:id/favorite` `{favorite:boolean}`
- `DELETE /api/items/:id` `{}`
- `GET /api/items/:id/download` → `{url}` (signed 5 min, Content-Disposition attachment) — open it in a new tab / `<a download>`. 410 `expired` after retention.
- `GET /api/gallery?favorite=1&before=ISO&beforeId=uuid` (keyset cursor = last item createdAt + id) → `[Item & {createdAt}]` (60 per page)
- `GET /api/credits/ledger` → `[{delta,balance_after,reason:'invite_grant'|'reserve'|'refund'|'admin_adjust',job_id,created_at}]` (AI-model previews appear as `reserve`/`refund` with `job_id: null`)

## Model library (我的模特库) — user, own rows only
- `GET /api/models-library/options` → `{groups:[{key,label,options:[{value,label}]}], defaults:{gender,age_range,look,hair,body,style}, candidates:2, unitPrice, cost}` (cost = unitPrice × candidates, charged per AI preview)
- `GET /api/models-library?source=ai|upload` → `[LibModel]`, newest first (max 200)
  - LibModel: `{id,name,source:'ai'|'upload',attrs,summary(中文属性摘要),portraitAssetId,createdAt,url,thumb}`
- `POST /api/models-library` `{name(1–30), assetId (an upload of mine), consent: true, attrs?}` → LibModel. Upload my own model photo; `consent` must be literally `true` (portrait-rights confirmation) else 400. The image is copied into a permanent portrait (never expires). Max 200 models.
- `PATCH /api/models-library/:id` `{name}` → `{ok}`
- `DELETE /api/models-library/:id` → `{ok}` (soft delete; past jobs keep working)
- `POST /api/models-library/ai/preview` `{attrs?:{gender,age_range,look,hair,body,style}, note?(≤120)}` → `{previewId, charged, refunded, credits, summary, candidates:[{assetId,width,height,url,thumb}]}`. Generates 2 fictional AI model portraits (3:4); takes up to ~2 min. Failed candidates are refunded. 10 previews/hour/user (429 `rate_limited`), 402 if not enough credits. Preview valid 2 h.
- `POST /api/models-library/ai/save` `{previewId, assetId (one of its candidates), name}` → LibModel (source `ai`). One save per preview; the other candidates are discarded. 410 `preview_expired` otherwise.
- To use a library model in a job: pass `{assetId: portraitAssetId, role:'model'}` in `POST /api/jobs` inputs.

## Inspiration templates (灵感模板)
- `GET /api/templates?category=美妆|服饰|食品|数码|家居|节日` → `[{id,title,category,mode,prompt,tags,ratios,quality,cover,thumb}]` (enabled only, by sort)
- `POST /api/templates/:id/use` `{}` → `{template, style:{id,width,height,thumb}}` — copies the cover into my uploads; prefill the workbench with `template.prompt/tags/ratios/quality/mode` and add `{assetId: style.id, role:'style'}`. 404 if disabled/missing.

## Admin (role=admin only)
- `POST /api/admin/users/:id/reset-password` `{}` → `{tempPassword, mustChangePassword:true}` (response `Cache-Control: no-store`). Shown **once**, never stored or logged; all the user's sessions are revoked and login lockout cleared; the user must change it at next login. 400 on your own account (use 修改密码). Users list rows include `must_change_password`.
- `GET /api/admin/stats?days=14` → `{daily:[{day,images,failed,credits,cost_fen}], byModel:[{model,ok,failed,avg_ms,fallbacks}], prefs:[{model,action,n}], totals:{users,active7,in_flight}}`
  - revenue_fen = credits × 10 (1 credit = ¥0.1 = 10 fen). margin = 1 − cost_fen / (credits×10)
- `GET /api/admin/users?q=` ; `PATCH /api/admin/users/:id` `{status?,role?,dailyLimit?:number|null,concurrencyOverride?:number|null}` ; `POST /api/admin/users/:id/credits` `{delta, note}` ; `GET /api/admin/users/:id/ledger`
- `GET /api/admin/invites?batch=` → rows `{id,code,credits,max_uses,used_count,daily_limit,expires_at,status,batch,note,created_at,used_by:string[]|null}` ; `POST /api/admin/invites` `{count,credits,maxUses?,dailyLimit?,expiresInDays?,batch?,note?}` → `{codes}` ; `POST /api/admin/invites/revoke` `{ids}`
- `GET /api/admin/channels` → `{id,name,vendor,purpose:'image'|'chat',base_url,key_last4,status,timeout_ms}` (key never returned) ; `POST /api/admin/channels` `{name,vendor:'gptchat2api'|'grok2api'|'openai_compat',purpose?:'image'|'chat'(default image),baseUrl(https, public),apiKey,status?,timeoutMs?}` ; `PATCH /api/admin/channels/:id` (any field optional; apiKey omitted = keep) ; `DELETE` ; `POST /api/admin/channels/:id/sync` `{}` → `{total,imageModels,purpose}` (+`chatModels` for chat channels)
  - **purpose `image`**: an image-generation relay. Sync stores its image models as real models (disabled by default) for binding/routing.
  - **purpose `chat`**: used **only** by the planner. Sync never creates real models, its models cannot be bound (`POST /api/admin/bindings` → 400), and routing ignores the channel. Use `openai_compat` vendor for a generic OpenAI-compatible LLM endpoint.
- `GET /api/admin/channels/:id/models` → `{all:string[], chat:string[], image:string[]}` — live `GET {baseUrl}/models` of any channel (not persisted, 20/min). Use the `chat` list to pick `planner_model`.
- `GET /api/admin/models` → `{id,channel_id,channel_name,vendor,purpose,model_id,enabled,caps,cost_standard_fen,cost_hd_fen}` ; `PATCH /api/admin/models/:id` `{enabled?,caps?,costStandardFen?,costHdFen?}`
  - caps: `{ratios:string[], hd:boolean, max_refs:int, edit:boolean, transparent?:boolean, mask?:boolean, n_max?:int}`. Routing uses `ratios/hd/max_refs/edit`; a job with more references than `max_refs` is tried on that model only after models that fit, with references trimmed product > model > style (logged as `fallback_drop_style` / `fallback_trim_refs`). `transparent/mask/n_max` are informational for now. Dev defaults (from model tests): gpt-image-2.5 `transparent:true, mask:false, n_max:2, max_refs:4`; grok-imagine-image-2.0 `transparent:false, mask:false, n_max:4, max_refs:3`.
- `GET /api/admin/platform-models` → `[{key:'grok'|'gpt',display_name,enabled,bindings:[{id,real_model_id,model_id,channel_name,priority,weight,enabled}]}]` ; `POST /api/admin/bindings` `{platformModelKey,realModelId,priority?,weight?}` ; `PATCH/DELETE /api/admin/bindings/:id`
- `GET /api/admin/rules` → `{id,name,priority,match:{quality?,min_refs?,max_refs?,tags_any?},primary_model,fallback_model,enabled}` ; `POST` / `PUT /:id` `{name,priority,match,primaryModel,fallbackModel,enabled}` ; `DELETE /:id`
- `GET/PUT /api/admin/pricing` `{standard,hd}` (GET returns the same object shape)
- `GET/PUT /api/admin/settings` `{concurrency_user,concurrency_global,beta_default_credits,beta_daily_image_limit,mix_batch_enabled,signup_enabled,feature_user_referral,max_images_per_job,planner_enabled,planner_channel_id,planner_model}` — PUT accepts any subset; unknown keys → 400; returns the full settings.
  - **Planner** (`planner_enabled` bool, default true; `planner_channel_id` channel uuid or `''`; `planner_model` model id or `''`): before generating, an LLM looks at the reference images + the user's sentence + tags and writes one professional prompt per image, product facts and a shared style lock (cached once per job in `jobs.plan`). It needs an **OpenAI-compatible vision chat model** (`POST {baseUrl}/chat/completions` accepting `image_url` data-URL content parts, ideally `response_format: json_object`), normally on a channel with `purpose: 'chat'`. If either id is `''`, the planner is disabled, or the call fails/times out (25 s), the job silently uses the built-in template prompt. If the planner flags the request as against content policy the items fail with `content_blocked` and are refunded. Currently **not configured** (template prompts).
- `GET /api/admin/items?status=failed` ; `GET /api/admin/audit`
- Templates: `GET /api/admin/templates` → `[Template & {sort,enabled,coverAssetId,createdAt}]` (incl. disabled) ; `POST /api/admin/templates/cover` multipart `file` → `{id,width,height,thumb}` (upload the cover first) ; `POST /api/admin/templates` `{title(1–30),category,mode:'simple'|'detailed',coverAssetId,ratios(1–4),prompt?(≤500),tags?,quality?,sort?,enabled?}` → `{id}` (coverAssetId must come from the cover endpoint, else 400; unknown tags are dropped) ; `PATCH /api/admin/templates/:id` (any subset; omitted = unchanged) ; `DELETE /api/admin/templates/:id`. Starter set: `node --env-file=.env --import tsx src/db/seedTemplates.ts` (idempotent).

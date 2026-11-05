CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Accounts =====
CREATE TABLE invite_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  credits       integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  max_uses      integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count    integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  daily_limit   integer CHECK (daily_limit IS NULL OR daily_limit >= 0),
  expires_at    timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  source        text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','user_referral')),
  note          text,
  batch         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (used_count <= max_uses)
);

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext NOT NULL UNIQUE,
  password_hash        text NOT NULL,
  display_name         text,
  role                 text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  credits              integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  daily_limit          integer CHECK (daily_limit IS NULL OR daily_limit >= 0),
  concurrency_override integer CHECK (concurrency_override IS NULL OR concurrency_override > 0),
  invite_code_id       uuid REFERENCES invite_codes(id),
  invite_quota_remaining integer NOT NULL DEFAULT 0, -- reserved for feature_user_referral (off)
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);
ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id);

CREATE TABLE invite_redemptions (
  id             bigserial PRIMARY KEY,
  invite_code_id uuid NOT NULL REFERENCES invite_codes(id),
  user_id        uuid NOT NULL UNIQUE REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,           -- sha256 of the cookie token; raw token never stored
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           inet,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ===== Credits =====
CREATE TABLE credit_ledger (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  delta         integer NOT NULL,
  balance_after integer NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('invite_grant','reserve','refund','admin_adjust')),
  job_id        uuid,
  item_id       uuid,
  actor_id      uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger(user_id, created_at DESC);

CREATE TABLE pricing (
  quality  text PRIMARY KEY CHECK (quality IN ('standard','hd')),
  credits  integer NOT NULL CHECK (credits > 0)
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Upstreams & models =====
CREATE TABLE upstream_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  vendor      text NOT NULL CHECK (vendor IN ('gptchat2api','grok2api','openai_compat')),
  base_url    text NOT NULL,
  api_key_enc bytea NOT NULL,
  key_version integer NOT NULL,
  key_last4   text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  timeout_ms  integer NOT NULL DEFAULT 300000,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE real_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid NOT NULL REFERENCES upstream_channels(id) ON DELETE CASCADE,
  model_id    text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  caps        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {ratios[], hd:boolean, max_refs, edit:boolean}
  cost_standard_fen numeric(10,2) NOT NULL DEFAULT 0,
  cost_hd_fen       numeric(10,2) NOT NULL DEFAULT 0,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, model_id)
);

CREATE TABLE platform_models (
  key          text PRIMARY KEY,           -- internal only, never shown to end users
  display_name text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true
);

CREATE TABLE route_bindings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_model_key text NOT NULL REFERENCES platform_models(key) ON DELETE CASCADE,
  real_model_id      uuid NOT NULL REFERENCES real_models(id) ON DELETE CASCADE,
  priority           integer NOT NULL DEFAULT 1,
  weight             integer NOT NULL DEFAULT 100 CHECK (weight > 0),
  enabled            boolean NOT NULL DEFAULT true,
  UNIQUE (platform_model_key, real_model_id)
);

CREATE TABLE routing_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  priority           integer NOT NULL,      -- lower = evaluated first
  match              jsonb NOT NULL DEFAULT '{}'::jsonb, -- {quality?, min_refs?, max_refs?, tags_any?[]}
  primary_model      text NOT NULL REFERENCES platform_models(key),
  fallback_model     text REFERENCES platform_models(key),
  enabled            boolean NOT NULL DEFAULT true
);

-- ===== Work =====
CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('simple','detailed')),
  cover_asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_user_idx ON projects(user_id, updated_at DESC);

CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('upload','output')),
  storage_key text NOT NULL UNIQUE,
  mime        text NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  bytes       integer NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_user_idx ON assets(user_id, created_at DESC);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','partial','failed')),
  mode             text NOT NULL,
  quality          text NOT NULL CHECK (quality IN ('standard','hd')),
  prompt           text NOT NULL,
  tags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  ratios           jsonb NOT NULL,
  per_ratio        integer NOT NULL,
  reserved_credits integer NOT NULL,
  refunded_credits integer NOT NULL DEFAULT 0,
  parent_item_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX jobs_user_idx ON jobs(user_id, created_at DESC);
CREATE INDEX jobs_project_idx ON jobs(project_id, created_at DESC);

CREATE TABLE job_inputs (
  job_id   uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id),
  role     text NOT NULL CHECK (role IN ('product','top','bottom','shoes','bag','accessory','model','style')),
  position integer NOT NULL,
  PRIMARY KEY (job_id, position)
);

CREATE TABLE job_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idx             integer NOT NULL,
  ratio           text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  planned_model   text NOT NULL,
  used_model      text,
  real_model_id   uuid REFERENCES real_models(id) ON DELETE SET NULL,
  used_quality    text,
  attempts        integer NOT NULL DEFAULT 0,
  fallback        boolean NOT NULL DEFAULT false,
  output_asset_id uuid REFERENCES assets(id),
  credits         integer NOT NULL,
  cost_fen        numeric(10,2),
  upstream_ms     integer,
  error_code      text,
  error_message   text,
  favorite        boolean NOT NULL DEFAULT false,
  deleted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX job_items_job_idx ON job_items(job_id, idx);
CREATE INDEX job_items_user_day_idx ON job_items(user_id, created_at);

CREATE TABLE generation_feedback (
  id         bigserial PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES job_items(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     text NOT NULL CHECK (action IN ('download','favorite','unfavorite','delete','regenerate')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE upstream_call_logs (
  id            bigserial PRIMARY KEY,
  item_id       uuid,
  real_model_id uuid,
  status_code   integer,
  error_class   text,
  ms            integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upstream_call_logs_created_idx ON upstream_call_logs(created_at DESC);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          inet,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);

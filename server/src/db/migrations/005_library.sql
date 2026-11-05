-- Model library (我的模特库) + inspiration templates (灵感模板).

-- assets.kind gains 'portrait' (library portraits, exempt from retention) and 'template' (template covers).
-- Union with whatever kinds other migrations may already have added, so we never drop one.
DO $$
DECLARE
  def  text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'assets'::regclass AND conname = 'assets_kind_check';
  SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}'::text[]) || ARRAY['upload','output','portrait','template']) AS v ORDER BY v);
  ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_kind_check;
  EXECUTE format('ALTER TABLE assets ADD CONSTRAINT assets_kind_check CHECK (kind = ANY (%L::text[]))', vals);
END $$;

CREATE TABLE IF NOT EXISTS model_library (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  source            text NOT NULL CHECK (source IN ('ai','upload')),
  portrait_asset_id uuid NOT NULL REFERENCES assets(id),
  attrs             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {gender, age_range, look, hair, body, style}
  consent_confirmed boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted           boolean NOT NULL DEFAULT false,
  CHECK (source <> 'upload' OR consent_confirmed)
);
CREATE INDEX IF NOT EXISTS model_library_user_idx ON model_library(user_id, created_at DESC) WHERE NOT deleted;

CREATE TABLE IF NOT EXISTS inspiration_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 30),
  category       text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('simple','detailed')),
  cover_asset_id uuid NOT NULL REFERENCES assets(id),
  prompt         text NOT NULL DEFAULT '' CHECK (char_length(prompt) <= 500),
  tags           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ratios         jsonb NOT NULL DEFAULT '["1:1"]'::jsonb,
  quality        text NOT NULL DEFAULT 'standard' CHECK (quality IN ('standard','hd')),
  sort           integer NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  seed_key       text UNIQUE,   -- set only by the starter seed script (idempotency)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspiration_templates_list_idx ON inspiration_templates(enabled, sort, created_at DESC);

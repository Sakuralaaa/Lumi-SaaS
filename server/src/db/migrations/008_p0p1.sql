-- P0/P1 (2026-10-29): storyboard + product facts + style lock, single-image retry / one-line edit / edit tools,
-- clone reference, auto QC, product library.

-- assets.kind gains 'product' (product-library images, exempt from retention). Union with existing kinds.
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'assets'::regclass AND conname = 'assets_kind_check';
  SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}'::text[]) || ARRAY['upload','output','portrait','template','product']) AS v ORDER BY v);
  ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_kind_check;
  EXECUTE format('ALTER TABLE assets ADD CONSTRAINT assets_kind_check CHECK (kind = ANY (%L::text[]))', vals);
END $$;

-- job_inputs.role gains 'base' (the image being edited) and 'clone' (competitor image whose composition is recreated).
ALTER TABLE job_inputs DROP CONSTRAINT IF EXISTS job_inputs_role_check;
ALTER TABLE job_inputs ADD CONSTRAINT job_inputs_role_check
  CHECK (role IN ('product','top','bottom','shoes','bag','accessory','model','style','clone','base'));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'generate',
  ADD COLUMN IF NOT EXISTS facts      jsonb,   -- {name, points[]} product facts / selling points (user text, policy-checked)
  ADD COLUMN IF NOT EXISTS shots      jsonb,   -- [{tag, text}] one per item idx: the storyboard the user saw and edited
  ADD COLUMN IF NOT EXISTS style_lock text,    -- snapshot of the project's locked style at creation time
  ADD COLUMN IF NOT EXISTS edit_op    text,    -- edit jobs: free | erase | expand | cutout | upscale | recolor
  ADD COLUMN IF NOT EXISTS edit_text  text;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('generate','retry','edit'));

ALTER TABLE projects ADD COLUMN IF NOT EXISTS style_lock jsonb;  -- {text, assetId, jobId, at}

ALTER TABLE job_items
  ADD COLUMN IF NOT EXISTS qc jsonb;         -- {pass, issues[], retried}

ALTER TABLE generation_feedback DROP CONSTRAINT IF EXISTS generation_feedback_action_check;
ALTER TABLE generation_feedback ADD CONSTRAINT generation_feedback_action_check
  CHECK (action IN ('download','favorite','unfavorite','delete','regenerate','retry','edit','zip'));

CREATE TABLE IF NOT EXISTS products (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  points     jsonb NOT NULL DEFAULT '[]'::jsonb,
  asset_ids  uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted    boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS products_user_idx ON products(user_id, updated_at DESC) WHERE NOT deleted;

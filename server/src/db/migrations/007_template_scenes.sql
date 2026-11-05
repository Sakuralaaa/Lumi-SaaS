-- Templates v2: hidden scene prompt (never sent to end users), optional text slots, purpose + short description.
ALTER TABLE inspiration_templates
  ADD COLUMN IF NOT EXISTS scene_prompt text NOT NULL DEFAULT '' CHECK (char_length(scene_prompt) <= 2500),
  ADD COLUMN IF NOT EXISTS allow_text   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fields       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS purpose      text NOT NULL DEFAULT '场景',
  ADD COLUMN IF NOT EXISTS descr        text NOT NULL DEFAULT '' CHECK (char_length(descr) <= 40),
  ADD COLUMN IF NOT EXISTS featured     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source       text NOT NULL DEFAULT '' CHECK (char_length(source) <= 200),
  ADD COLUMN IF NOT EXISTS uses         integer NOT NULL DEFAULT 0;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS template_id     uuid REFERENCES inspiration_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_fields jsonb,
  -- snapshot of the rendered scene at creation time (admin edits never change a running job)
  ADD COLUMN IF NOT EXISTS template_scene  text,
  ADD COLUMN IF NOT EXISTS template_text   boolean NOT NULL DEFAULT false;

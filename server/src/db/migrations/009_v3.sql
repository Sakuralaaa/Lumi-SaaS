-- v3 (2026-10-29): brand settings, per-image storyboard rows, tools project, text overlay, translate / model swap / pose edits.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS brand jsonb,                         -- {color, font, lang, note}
  ADD COLUMN IF NOT EXISTS tools boolean NOT NULL DEFAULT false; -- hidden per-user project that holds 工具箱 edits
CREATE UNIQUE INDEX IF NOT EXISTS projects_tools_one ON projects(user_id) WHERE tools;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS brand jsonb;          -- snapshot of the project's brand settings

ALTER TABLE generation_feedback DROP CONSTRAINT IF EXISTS generation_feedback_action_check;
ALTER TABLE generation_feedback ADD CONSTRAINT generation_feedback_action_check
  CHECK (action IN ('download','favorite','unfavorite','delete','regenerate','retry','edit','zip','overlay'));

-- Planner layer: one cached plan per job (LLM-written prompts + product facts), and a free-form note on upstream calls
-- (e.g. 'fallback_drop_style' when reference images were trimmed for a model with a lower max_refs).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS plan jsonb;
ALTER TABLE upstream_call_logs ADD COLUMN IF NOT EXISTS note text;

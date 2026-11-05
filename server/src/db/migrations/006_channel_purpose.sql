-- Channel purpose: 'image' channels serve image generation (sync creates real_models, can be bound/routed);
-- 'chat' channels are used only by the planner LLM (sync never creates real_models; routing ignores them).
ALTER TABLE upstream_channels ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'image';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upstream_channels_purpose_check') THEN
    ALTER TABLE upstream_channels ADD CONSTRAINT upstream_channels_purpose_check CHECK (purpose IN ('image','chat'));
  END IF;
END $$;

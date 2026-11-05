-- Ops: idempotent job creation, forced password change, retention bookkeeping.

-- Idempotency-Key for POST /api/jobs. (user_id, key) is unique; the row is inserted in the
-- same transaction as the credit reserve, so concurrent duplicates serialize on the PK.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          uuid NOT NULL,
  request_hash text NOT NULL,
  job_id       uuid REFERENCES jobs(id) ON DELETE CASCADE,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys(created_at);

-- Admin password reset → user must change password before using the app.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Retention: storage objects are deleted, the row is kept and marked.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS purged_at timestamptz;
CREATE INDEX IF NOT EXISTS assets_retention_idx ON assets(created_at) WHERE purged_at IS NULL;

-- Soft-delete timestamp so files of deleted items can be purged after 24h.
ALTER TABLE job_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
UPDATE job_items SET deleted_at = now() WHERE deleted AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS job_items_deleted_idx ON job_items(deleted_at) WHERE deleted;

CREATE INDEX IF NOT EXISTS job_inputs_asset_idx ON job_inputs(asset_id);
CREATE INDEX IF NOT EXISTS job_items_output_asset_idx ON job_items(output_asset_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

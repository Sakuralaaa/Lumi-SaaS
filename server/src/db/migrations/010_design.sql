-- Layered design documents (图层编辑器): the editable layers behind an overlay version.
ALTER TABLE job_items ADD COLUMN IF NOT EXISTS design jsonb;

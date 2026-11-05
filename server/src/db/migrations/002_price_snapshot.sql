-- Price snapshot per job: admin price changes only affect new jobs; refunds use the price the user paid.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS unit_price_standard integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS unit_price_hd integer;

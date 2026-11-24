ALTER TABLE cs_trp_013_v2.orders
  ALTER COLUMN account DROP NOT NULL,
  ADD COLUMN hosted_checkout boolean NOT NULL DEFAULT false,
  ADD COLUMN checkout_provider_id text UNIQUE,
  ADD COLUMN checkout_url text,
  ADD COLUMN checkout_expires_at timestamptz,
  ADD COLUMN checkout_synced_at timestamptz;

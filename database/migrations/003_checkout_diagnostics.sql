ALTER TABLE cs_trp_013_v2.orders
  ADD COLUMN checkout_http integer,
  ADD COLUMN checkout_error text,
  ADD COLUMN checkout_attempted_at timestamptz,
  ADD COLUMN reconciliation_state text,
  ADD COLUMN reconciliation_error text,
  ADD COLUMN reconciliation_http integer,
  ADD COLUMN reconciliation_at timestamptz;

ALTER TABLE cs_trp_013_v2.gateway
  ADD COLUMN last_error text,
  ADD COLUMN last_authenticated boolean,
  ADD COLUMN checkout_readable boolean,
  ADD COLUMN checkout_creation_verified_at timestamptz,
  ADD COLUMN checkout_attempted_at timestamptz,
  ADD COLUMN checkout_http integer,
  ADD COLUMN checkout_error text;

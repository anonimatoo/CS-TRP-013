CREATE TABLE cs_trp_013_v2.merchant_accounts (
  merchant_id uuid PRIMARY KEY REFERENCES cs_trp_013_v2.merchants(id),
  email text NOT NULL UNIQUE CHECK (email=lower(email)),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cs_trp_013_v2.sessions ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchant_accounts(merchant_id);
ALTER TABLE cs_trp_013_v2.orders ALTER COLUMN price_version DROP NOT NULL;
ALTER TABLE cs_trp_013_v2.orders ADD CONSTRAINT order_price_source CHECK (price_version IS NOT NULL OR hosted_checkout);
CREATE INDEX orders_merchant_custom_links_idx ON cs_trp_013_v2.orders(merchant_id,environment,created_at DESC,id)
  WHERE hosted_checkout AND price_version IS NULL;

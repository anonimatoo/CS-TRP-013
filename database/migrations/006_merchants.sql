CREATE TABLE cs_trp_013_v2.merchants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  quarantined boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cs_trp_013_v2.merchants(id,name,quarantined) VALUES
  ('00000000-0000-4000-8000-000000000001','Lojista original',false),
  ('00000000-0000-4000-8000-000000000002','Histórico sem titularidade verificada',true);

ALTER TABLE cs_trp_013_v2.product ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id);
ALTER TABLE cs_trp_013_v2.prices ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id);
ALTER TABLE cs_trp_013_v2.gateway
  ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id),
  ADD COLUMN secret_scoped boolean NOT NULL DEFAULT false,
  ADD COLUMN secret_fingerprint text;
ALTER TABLE cs_trp_013_v2.orders ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id);
ALTER TABLE cs_trp_013_v2.transactions ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id);
ALTER TABLE cs_trp_013_v2.payment_actions ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id);
ALTER TABLE cs_trp_013_v2.webhook_events
  ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id),
  ADD COLUMN environment text;
ALTER TABLE cs_trp_013_v2.audit ADD COLUMN merchant_id uuid REFERENCES cs_trp_013_v2.merchants(id);

UPDATE cs_trp_013_v2.product SET merchant_id='00000000-0000-4000-8000-000000000001';
UPDATE cs_trp_013_v2.prices SET merchant_id='00000000-0000-4000-8000-000000000001';
UPDATE cs_trp_013_v2.gateway SET merchant_id='00000000-0000-4000-8000-000000000001';

UPDATE cs_trp_013_v2.orders o SET merchant_id=CASE
  WHEN o.account ~ '^acc_[A-Za-z0-9]{4,100}$' AND o.account=g.account THEN g.merchant_id
  ELSE '00000000-0000-4000-8000-000000000002'::uuid END
FROM cs_trp_013_v2.gateway g WHERE g.environment=o.environment;

UPDATE cs_trp_013_v2.transactions t SET merchant_id=o.merchant_id FROM cs_trp_013_v2.orders o WHERE t.order_id=o.id;
UPDATE cs_trp_013_v2.payment_actions a SET merchant_id=o.merchant_id FROM cs_trp_013_v2.orders o WHERE a.order_id=o.id;
UPDATE cs_trp_013_v2.webhook_events w SET merchant_id=o.merchant_id,environment=o.environment
FROM cs_trp_013_v2.orders o WHERE w.order_id=o.id;

ALTER TABLE cs_trp_013_v2.orders DROP CONSTRAINT orders_environment_fkey, DROP CONSTRAINT orders_price_version_fkey;
ALTER TABLE cs_trp_013_v2.product DROP CONSTRAINT product_pkey, ALTER COLUMN merchant_id SET NOT NULL, ADD PRIMARY KEY (merchant_id,id);
ALTER TABLE cs_trp_013_v2.prices DROP CONSTRAINT prices_pkey, ALTER COLUMN merchant_id SET NOT NULL, ADD PRIMARY KEY (merchant_id,version);
ALTER TABLE cs_trp_013_v2.gateway DROP CONSTRAINT gateway_pkey, ALTER COLUMN merchant_id SET NOT NULL, ADD PRIMARY KEY (merchant_id,environment);
CREATE UNIQUE INDEX gateway_account_env_unique ON cs_trp_013_v2.gateway(environment,account) WHERE account IS NOT NULL;
CREATE UNIQUE INDEX gateway_pk_unique ON cs_trp_013_v2.gateway(environment,public_key) WHERE public_key IS NOT NULL;
CREATE UNIQUE INDEX gateway_secret_fingerprint_unique ON cs_trp_013_v2.gateway(secret_fingerprint) WHERE secret_fingerprint IS NOT NULL;

INSERT INTO cs_trp_013_v2.gateway(merchant_id,environment) VALUES
  ('00000000-0000-4000-8000-000000000002','test'),('00000000-0000-4000-8000-000000000002','live');
INSERT INTO cs_trp_013_v2.prices(merchant_id,version,amount,created_at)
SELECT DISTINCT o.merchant_id,p.version,p.amount,p.created_at
FROM cs_trp_013_v2.orders o JOIN cs_trp_013_v2.prices p ON p.version=o.price_version
WHERE o.merchant_id='00000000-0000-4000-8000-000000000002';

ALTER TABLE cs_trp_013_v2.orders
  ALTER COLUMN merchant_id SET NOT NULL,
  DROP CONSTRAINT orders_provider_order_key,
  DROP CONSTRAINT orders_provider_charge_key,
  DROP CONSTRAINT orders_checkout_provider_id_key,
  ADD UNIQUE (merchant_id,environment,provider_order),
  ADD UNIQUE (merchant_id,environment,provider_charge),
  ADD CONSTRAINT orders_merchant_env_checkout_key UNIQUE (merchant_id,environment,checkout_provider_id),
  ADD UNIQUE (merchant_id,id),
  ADD UNIQUE (merchant_id,environment,id),
  ADD FOREIGN KEY (merchant_id,environment) REFERENCES cs_trp_013_v2.gateway(merchant_id,environment),
  ADD FOREIGN KEY (merchant_id,price_version) REFERENCES cs_trp_013_v2.prices(merchant_id,version);
CREATE INDEX orders_merchant_history_idx ON cs_trp_013_v2.orders(merchant_id,environment,created_at DESC,id);

ALTER TABLE cs_trp_013_v2.transactions ALTER COLUMN merchant_id SET NOT NULL,
  ADD FOREIGN KEY (merchant_id,order_id) REFERENCES cs_trp_013_v2.orders(merchant_id,id);
ALTER TABLE cs_trp_013_v2.payment_actions ALTER COLUMN merchant_id SET NOT NULL,
  ADD FOREIGN KEY (merchant_id,order_id) REFERENCES cs_trp_013_v2.orders(merchant_id,id);
ALTER TABLE cs_trp_013_v2.webhook_events
  DROP CONSTRAINT webhook_events_pkey,
  ALTER COLUMN merchant_id SET NOT NULL,
  ALTER COLUMN environment SET NOT NULL,
  ADD PRIMARY KEY(merchant_id,environment,id),
  ADD FOREIGN KEY (merchant_id,environment,order_id) REFERENCES cs_trp_013_v2.orders(merchant_id,environment,id);

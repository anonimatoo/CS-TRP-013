ALTER TABLE cs_trp_013_v2.orders ADD COLUMN telegram_payment jsonb;
CREATE INDEX orders_telegram_confirmed_idx ON cs_trp_013_v2.orders(merchant_id,confirmed_at,id)
  WHERE environment='live' AND telegram_payment IS NOT NULL AND status IN ('paid','captured');

CREATE TABLE cs_trp_013_v2.telegram_config (
  id integer PRIMARY KEY CHECK (id=1),
  secret text,
  enabled boolean NOT NULL DEFAULT true,
  next_dispatch_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cs_trp_013_v2.telegram_config(id) VALUES (1);

CREATE TABLE cs_trp_013_v2.telegram_authorizations (
  merchant_id uuid PRIMARY KEY REFERENCES cs_trp_013_v2.merchants(id),
  authorization_id uuid NOT NULL,
  destination text NOT NULL,
  authorized_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE cs_trp_013_v2.telegram_outbox (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment='live'),
  order_id uuid NOT NULL,
  transaction_id text NOT NULL,
  authorization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  FOREIGN KEY (merchant_id,environment,order_id) REFERENCES cs_trp_013_v2.orders(merchant_id,environment,id),
  UNIQUE (merchant_id,environment,transaction_id),
  UNIQUE (merchant_id,environment,order_id)
);
CREATE INDEX telegram_outbox_pending_idx ON cs_trp_013_v2.telegram_outbox(next_attempt_at,id) WHERE status='pending';
CREATE INDEX telegram_outbox_lease_idx ON cs_trp_013_v2.telegram_outbox(lease_until) WHERE status='processing';
CREATE INDEX telegram_outbox_history_idx ON cs_trp_013_v2.telegram_outbox(merchant_id,created_at DESC,id);

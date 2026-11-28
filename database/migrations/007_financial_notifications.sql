ALTER TABLE cs_trp_013_v2.orders ADD COLUMN card_brand text,
  ADD COLUMN fee_amount integer, ADD COLUMN net_amount integer, ADD COLUMN confirmed_at timestamptz;

CREATE TABLE cs_trp_013_v2.report_settings (
  merchant_id uuid PRIMARY KEY REFERENCES cs_trp_013_v2.merchants(id),
  enabled boolean NOT NULL DEFAULT false,
  authorized boolean NOT NULL DEFAULT false,
  recipients text[] NOT NULL DEFAULT '{}',
  authorized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cs_trp_013_v2.mail_settings (
  id integer PRIMARY KEY CHECK(id=1),
  username text NOT NULL,
  sender text NOT NULL,
  secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cs_trp_013_v2.notification_outbox (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment='live'),
  order_id uuid NOT NULL,
  transaction_id text NOT NULL,
  recipient text NOT NULL,
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_id uuid,
  dispatch_started boolean NOT NULL DEFAULT false,
  last_error text,
  FOREIGN KEY (merchant_id,environment,order_id) REFERENCES cs_trp_013_v2.orders(merchant_id,environment,id),
  UNIQUE (merchant_id,environment,transaction_id,recipient)
);
CREATE INDEX notification_pending_idx ON cs_trp_013_v2.notification_outbox(next_attempt_at,id) WHERE status='pending';
CREATE INDEX notification_lease_idx ON cs_trp_013_v2.notification_outbox(lease_until) WHERE status='processing';
CREATE INDEX notification_history_idx ON cs_trp_013_v2.notification_outbox(merchant_id,created_at DESC,id);

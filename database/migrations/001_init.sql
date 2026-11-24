CREATE SCHEMA IF NOT EXISTS cs_trp_013;
CREATE TABLE cs_trp_013.product (
  id integer PRIMARY KEY CHECK (id = 1),
  name text NOT NULL, description text NOT NULL, image text NOT NULL,
  amount integer CHECK (amount > 0), max_installments integer NOT NULL DEFAULT 1 CHECK (max_installments BETWEEN 1 AND 24),
  enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test','live')),
  operation text NOT NULL DEFAULT 'auth_and_capture' CHECK (operation IN ('auth_and_capture','auth_only'))
);
INSERT INTO cs_trp_013.product (id,name,description,image) VALUES
(1,'PC Gamer','Computador gamer personalizado','/images/pc-gamer.webp');
CREATE TABLE cs_trp_013.prices (
  version integer PRIMARY KEY, amount integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cs_trp_013.gateway (
  environment text PRIMARY KEY CHECK (environment IN ('test','live')),
  account text, mode text CHECK (mode IN ('gateway','psp')),
  public_key text, secret text, enabled boolean NOT NULL DEFAULT false,
  last_ok boolean, last_http integer, last_message text, tested_at timestamptz,
  updated_at timestamptz, version integer NOT NULL DEFAULT 0
);
INSERT INTO cs_trp_013.gateway (environment) VALUES ('test'),('live');
CREATE TABLE cs_trp_013.orders (
  id uuid PRIMARY KEY, environment text NOT NULL REFERENCES cs_trp_013.gateway(environment),
  account text NOT NULL, price_version integer NOT NULL REFERENCES cs_trp_013.prices(version),
  amount integer NOT NULL, installments integer NOT NULL, product_name text NOT NULL,
  status text NOT NULL, provider_order text UNIQUE, provider_charge text UNIQUE,
  http_status integer, refusal_code text, refusal_reason text,
  provider_status text, provider_updated_at timestamptz, actual_paid integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_account_idx ON cs_trp_013.orders (environment,account,created_at DESC);
CREATE TABLE cs_trp_013.transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES cs_trp_013.orders(id),
  provider_id text, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cs_trp_013.payment_actions (
  order_id uuid NOT NULL REFERENCES cs_trp_013.orders(id), action text NOT NULL,
  request_id uuid NOT NULL UNIQUE, attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id,action)
);
CREATE TABLE cs_trp_013.webhook_events (
  id text PRIMARY KEY, type text NOT NULL, order_id uuid NOT NULL REFERENCES cs_trp_013.orders(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cs_trp_013.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cs_trp_013.sessions (
  id text PRIMARY KEY, csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry_idx ON cs_trp_013.sessions (expires_at);
CREATE TABLE cs_trp_013.rate_limits (
  id text PRIMARY KEY, window_end timestamptz NOT NULL, attempts integer NOT NULL
);
CREATE INDEX rate_expiry_idx ON cs_trp_013.rate_limits (window_end);

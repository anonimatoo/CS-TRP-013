ALTER TABLE cs_trp_013_v2.gateway
  ADD COLUMN credit_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN debit_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN debit_authorization_reference text,
  ADD COLUMN credit_requires_3ds boolean NOT NULL DEFAULT true,
  ADD COLUMN debit_requires_3ds boolean NOT NULL DEFAULT true;

ALTER TABLE cs_trp_013_v2.orders
  ADD COLUMN payment_method text CHECK (payment_method IN ('credit_card','debit_card')),
  ADD COLUMN authorized_amount integer,
  ADD COLUMN provider_transaction text,
  ADD COLUMN authentication_status text;

UPDATE cs_trp_013_v2.orders SET payment_method='credit_card' WHERE hosted_checkout;

ALTER TABLE cs_trp_013_v2.transactions
  ADD COLUMN payment_method text CHECK (payment_method IN ('credit_card','debit_card')),
  ADD COLUMN authorized_amount integer,
  ADD COLUMN authentication_status text,
  ADD COLUMN refusal_code text,
  ADD COLUMN refusal_reason text;

UPDATE cs_trp_013_v2.transactions t SET payment_method=o.payment_method
FROM cs_trp_013_v2.orders o WHERE t.order_id=o.id AND o.hosted_checkout;

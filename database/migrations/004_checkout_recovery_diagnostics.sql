ALTER TABLE cs_trp_013_v2.orders
  ADD COLUMN checkout_diagnostic jsonb,
  ADD COLUMN reconciliation_diagnostics jsonb;

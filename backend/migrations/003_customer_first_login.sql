-- Customer phone verification and first-login password setup.
-- Apply only after 002_customer_portal.sql. Review rollback requirements before
-- deploying: customer_accounts may contain NULL email/password_hash values.

ALTER TABLE customers
  ADD COLUMN customer_phone_normalized VARCHAR(32) NULL AFTER customer_phone;

-- Formatting-only normalization. Keep every digit; do not infer country codes,
-- remove leading zeroes, or merge suffix matches. Duplicate keys are allowed so
-- the application can reject ambiguous phone ownership safely.
UPDATE customers
   SET customer_phone_normalized = NULLIF(REGEXP_REPLACE(customer_phone, '[^0-9]', ''), '')
 WHERE customer_phone IS NOT NULL;

CREATE INDEX ix_customers_company_phone_normalized
  ON customers (company_id, customer_phone_normalized);

ALTER TABLE customer_accounts
  MODIFY email VARCHAR(254) NULL,
  MODIFY password_hash VARCHAR(255) NULL;

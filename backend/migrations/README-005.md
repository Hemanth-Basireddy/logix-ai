# Migration 005 deployment notes

`005_transport_pricing_and_demo_payments.sql` depends on migrations 001–004 and extends the customer booking requests and shipments tables before adding company rate/payment configuration, payment/collection records, and transport trip/manifest/event tables. It stores a minimum charge and explicit sender/receiver payer policy, and demo collection channels are `DEMO_CASH` and `DEMO_UPI`.

Apply migrations in numeric order: 001, 002, 003, 004, then 005. Confirm the target schema/database explicitly before running SQL. Do not point a test run at `logistics_db` or `roammate_db`; create and positively identify a separate disposable database first. Take and verify a database backup before production deployment.

The trip reference shown in the UI is derived from the persisted unique `trip_id`; no duplicate reference column is needed.

MySQL DDL commits implicitly, so this migration is not transactionally reversible as a whole. If deployment fails partway, stop and inspect which `ALTER TABLE`/`CREATE TABLE` statements succeeded before retrying. Rollback requires a reviewed reverse migration that drops only the new 005 tables and columns; it will discard any pricing, payment, collection, or trip data written after deployment. Do not run a blanket rollback automatically.

Pricing rows and `company_payment_settings` rows are configuration data and are not seeded by this migration. Until a company rate exists for the selected route/service, the booking API returns “price to be confirmed” and does not invent a charge. Demo UPI is a non-payable project simulation; it is enabled by `DEMO_PAYMENTS_ENABLED` only outside production by default, and it must never be described as bank-confirmed payment.

Before production use, validate the target MySQL version/collation against the existing schema, review foreign-key key types, configure company-specific rates and supported collection methods, set `DEMO_PAYMENTS_ENABLED=false`, back up, apply migrations, verify the schema, and exercise one approved non-customer test shipment through the complete workflow.

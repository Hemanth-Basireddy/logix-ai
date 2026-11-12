# Customer portal MySQL integration tests

`npm run test:customer-integration` exercises the customer portal against MySQL. It is deliberately separate from the application's normal `DB_*` connection.

## Provision a disposable database

Use a local MySQL **8.0.4 or newer** instance. Migration 002 uses the MySQL 8 `utf8mb4_0900_ai_ci` collation and migration 003 uses `REGEXP_REPLACE`; MariaDB is not accepted by the test runner. Provision a new database named with the exact prefix `logix_customer_test_`, for example `logix_customer_test_local`, and a user restricted to that database. Provisioning is an operator action; the test runner never creates or drops databases.

Load only the project's authoritative pre-customer-portal schema into this database. The repository does not contain a complete baseline DDL/schema dump, so do not derive one from production data or guess its columns and keys. Use the approved schema source for the same application version, with no rows in `companies`, `customers`, `hubs`, `routes`, `shipments`, or `shipment_events`. Customer portal tables must not already contain data. Do not clone customer, employee, or shipment records from a protected database.

Configure these dedicated variables in the shell/process that runs the integration command:

```text
LOGIX_DB_MODE=test
LOGIX_TEST_DB_HOST=127.0.0.1
LOGIX_TEST_DB_PORT=3306
LOGIX_TEST_DB_NAME=logix_customer_test_local
LOGIX_TEST_DB_USER=logix_test
LOGIX_TEST_DB_PASSWORD=<test-only password>
CUSTOMER_PORTAL_MODE=demo
JWT_SECRET=<at least 32 random characters for this test process>
```

Do not set `LOGIX_TEST_DB_*` to either `logistics_db` or `roammate_db`. Test mode requires every dedicated connection field, validates the database-name prefix, and never falls back to `DB_*`. The application `.env` settings are left unchanged. Do not commit test credentials.

## Run

From the repository root:

```powershell
$env:LOGIX_DB_MODE = 'test'
$env:LOGIX_TEST_DB_HOST = '127.0.0.1'
$env:LOGIX_TEST_DB_PORT = '3306'
$env:LOGIX_TEST_DB_NAME = 'logix_customer_test_local'
$env:LOGIX_TEST_DB_USER = 'logix_test'
$env:LOGIX_TEST_DB_PASSWORD = '<test-only password>'
$env:CUSTOMER_PORTAL_MODE = 'demo'
npm run test:customer-integration --workspace backend
```

The runner first verifies the connected database identity, MySQL version, base-table columns/key compatibility, and that all relevant tables are empty. It then applies `002_customer_portal.sql` followed by `003_customer_first_login.sql`, seeds synthetic records, runs customer service/database checks, and deletes only the synthetic rows it inserted. It never drops the database. If schema checks fail, execution stops with an incompatibility message; do not edit the migrations to guess at missing schema details.

Migration 003 backfills `customers.customer_phone_normalized`, so its production deployment must be reviewed for table size/lock impact and run only after migration 002. Rollback needs an explicit backup/plan for both new tables and the phone/account columns and index; dropping them would erase customer portal credentials/bookings. The integration runner only operates on an explicitly named disposable database and is not a production migration tool.

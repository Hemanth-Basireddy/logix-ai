# W1 Application Evidence

Evidence captured from the existing Logix AI application on 13 November 2026. The screenshot files are direct Chrome captures of the running local app; Chrome used a new temporary profile with no saved login/session. No screenshot contains customer records, employee data, credentials, or tokens.

## Screenshots

| Filename | Demonstrates | Screen/workflow | Verified with real MySQL data? | Limitations |
|---|---|---|---|---|
| `w1_navigation.png` | Customer entry navigation with DTDC available, Delhivery marked Coming Soon, and Employee Login | Public entry (`/`) | The page was served by the running project. The screenshot itself has no shipment data. MySQL connectivity was independently verified read-only. | Does not demonstrate an authenticated role redirect. |
| `w1_customer_login.png` | Existing customer sign-in form and demo first-login guidance | Customer login (`/customer/login`) | The live backend customer configuration endpoint returned hub/service configuration from the configured database. No customer identity or shipment data was displayed. | No customer credentials were available; sign-in and dashboard were not exercised. |
| `w1_employee_login.png` | Employee ID/password sign-in screen | Employee login (`/login`) | The page was served by the running project. No database-backed employee data was displayed. | No authorized test account was provided; employee dashboard role routing was not exercised. |

The requested `w1_customer_booking.png`, `w1_operations_approval.png`, `w1_company_admin_dashboard.png`, `w1_hub_manager_dashboard.png`, `w1_logistics_executive_dashboard.png`, `w1_booking_success.png`, and `w1_mysql_evidence.png` were not captured. Booking and employee workspaces require authentication, and a successful booking/approval would write operational records. No authorized test credentials or isolated test database were available, so those flows were not attempted against `logistics_db`. A MySQL client executable is installed, but no database GUI/screenshot workflow was available; query output is recorded below without exposing row-level data. `w1_dataset_analysis.png` was not captured because no dataset-analysis notebook/output artifact was found among the project evidence assets.

## Verification summary

### Application and navigation

- The current checkout was clean on branch `main` before evidence capture. Existing local API and Vite listeners were identified as Node processes running this project and were reused; no unknown process was stopped.
- Backend `/api/health`: HTTP 200 (`{"status":"ok"}`).
- Backend `/api/customer/config`: HTTP 200; returned configured hubs and service modes. Historical demo name-login was reported enabled by the running backend configuration.
- Frontend `/`, `/customer/login`, and `/login`: HTTP 200. Chrome screenshots were captured using a new profile, not an existing authenticated browser session.
- Unauthenticated `/api/auth/me`: HTTP 401, expected for the clean browser profile. `/api/customer/me`: HTTP 200 with no authenticated customer.
- `App.tsx` defines guarded workspaces for Company Admin, Operations Manager, Hub Manager, and Logistics Executive. Those authenticated pages and their post-login redirects were not browser-verified because no authorized test account was supplied.

### Booking and approval

- The implementation and API routes are described in the root README and present in the application code: customer booking requests, Operations Manager approval/rejection, and official consignment creation on approval.
- No booking, approval, rejection, customer registration, shipment event, or other database write was performed for this evidence pass. Therefore success/reference generation and real dashboard updates are **not verified here**.

### Database connectivity (read-only)

The existing backend configuration connected to database `logistics_db`, MySQL `8.0.46`. Read-only inspection returned 18 tables, including the expected `companies`, `customers`, `employees`, `hubs`, `shipments`, and `shipment_events` tables. Aggregate row counts were:

- Companies: 1
- Customers: 41,833
- Employees: 121
- Hubs: 36
- Shipments: 49,631
- Shipment events: 15

No customer names, phone numbers, addresses, credentials, or shipment identifiers were queried for display or captured. No migration was run and no database settings or records were changed.

### Tests and checks executed

| Check | Result | Details |
|---|---|---|
| Backend unit tests | **FAIL — 89 passed, 1 failed (90 total)** | `trip creation accepts multiple physically received shipments and persists a single manifest` fails because its fixture does not supply an active company route; code returns `No active company route connects these hubs.` |
| Frontend tests | **FAIL — 8 passed, 1 failed (9 total)** | `empty company data displays actual zero-valued highlights without invented claims` rejects the intended disclosure text `not live vehicle locations` due to an overbroad regular expression. |
| Backend + frontend typecheck | **PASS** | `npm.cmd run typecheck` |
| Production build | **PASS with advisory** | `npm.cmd run build`; Vite reports large Plotly/Sankey chunks above 500 kB. |

No application source, database, or environment file was changed for this evidence capture. Existing code/test failures were recorded, not altered as part of the W1 evidence task.

## Implemented screens and known gaps

- Implemented role-specific workspaces/routes: Company Admin, Operations Manager, Hub Manager, and Logistics Executive. Backend role/company/hub/customer authorization is enforced in API routes; browser access to authenticated workspaces remains unverified in this evidence run.
- Customer entry and sign-in pages were visually verified. Booking, shipment history, labels, and tracking require a customer session and were not screenshot-tested here.
- Booking requests and Operations Manager approval/rejection are implemented; no live booking workflow was executed.
- Payments remain partial/demo: demo UPI is simulated and no payment gateway is connected. OTP provider configuration exists but is not wired into the customer HTTP flow. Power BI has setup/status only; no report/token integration. AI services and external courier feeds are not connected. SSE is in-process and is not cross-instance delivery.

## Evidence scope

This folder contains only the three new public-page screenshots and this index for W1. Existing image assets were left untouched. The screenshots do not establish that authenticated role dashboards, booking writes, or booking approvals work end to end.

## Follow-up: authenticated evidence readiness (13 November 2026)

No new screenshots were captured in this follow-up. The three previously published screenshots were not modified or removed.

### Authentication and safe test access

- Employee authentication accepts an employee ID and password and verifies an existing Argon2id hash. The project contains no seeded employee test-account instructions or safe development login; no employee password was guessed, reset, or reused.
- The customer demo first-login path is enabled by the current `backend/.env` setting `CUSTOMER_PORTAL_MODE=demo`, for `CUSTOMER_PORTAL_COMPANY_ID=1`. `LOGIX_DB_MODE` and every `LOGIX_TEST_DB_*` variable are absent, so the normal application target is `DB_NAME=logistics_db`.
- In demo mode, a historical customer may claim an exact matching record using the registered phone and customer name as the first password. The implementation persists a new Argon2id hash/account for that customer. That is a database write, so this login path was not used against `logistics_db`.
- A read-only MySQL catalog check found no database named with the required `logix_customer_test_` prefix. No test connection, migration, seed, booking, account creation, or other write was attempted.
- The customer integration runner requires a separately provisioned empty disposable database and an approved schema-only baseline. The repository's customer integration guide says the complete authoritative base DDL is not included. Its runner applies migrations 002, 003, and 004 and seeds/cleans its own synthetic customer workflow fixtures; it does not provide synthetic employee accounts for the role dashboard screenshots.

### Dataset analysis availability

No CSV, Excel workbook, Jupyter notebook, dataset-analysis output, or column-mapping artifact was found in the repository. No `w1_dataset_analysis.png` was created.

### Test rerun and failure investigation

The existing suites were rerun without code or test changes:

| Check | Rerun result | Finding |
|---|---|---|
| Backend tests | **FAIL — 89 passed, 1 failed (90 total)** | The trip-creation test's mock supplies `{ route: 1 }`, but the current route-graph query requires origin hub, destination hub, and destination city fields. The mock therefore creates no valid route edge, and the backend correctly rejects the trip. This is a stale fixture, not evidence that route validation should be weakened. |
| Frontend tests | **FAIL — 8 passed, 1 failed (9 total)** | The empty-summary assertion forbids the substring `live vehicle locations`; the UI intentionally states `not live vehicle locations`. This is an overbroad assertion against the truthful disclaimer; the disclaimer was preserved. |

Neither failure was changed in this evidence task.

### Exact prerequisites for the remaining screenshots

To capture customer booking and role dashboards safely, provision a separate MySQL database named with `logix_customer_test_...`, using the authoritative schema-only DDL for this application version and a database user restricted to that test database. Set all required `LOGIX_TEST_DB_*` variables and `LOGIX_DB_MODE=test` in the test process; do not repoint `backend/.env`. Provide synthetic test-only customer and employee accounts (Company Admin, Operations Manager, Hub Manager, and Logistics Executive), with appropriate company/hub/task fixtures and passwords created through the normal Argon2id process. The customer workflow can then be submitted and approved only in that isolated database. A genuine dataset-analysis screenshot additionally requires the project's actual analysis notebook/output or approved dataset mapping artifact.

Until those prerequisites exist, booking validation/submission, booking reference creation, Operations approval/rejection, and authenticated dashboard screenshots remain **blocked**, and the operational `logistics_db` remains unchanged.

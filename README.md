# Logix AI Control Tower

Logistics platform with employee workspaces and a Customer Portal: React +
TypeScript frontend and Express + TypeScript API, backed by MySQL.

## Local setup

1. Install Node.js 20 or later and MySQL 8.
2. Copy `backend/.env.example` to `backend/.env`.
3. Set `DB_PASSWORD` to the local MySQL account password and replace
   `JWT_SECRET` with a unique random value of at least 32 characters. Keep
   `backend/.env` private; it is git-ignored.
4. Install dependencies with `npm install`.
5. Start the API and Vite frontend with `npm run dev`.
6. Open the Vite URL shown in the terminal. The frontend proxies `/api` to the
   local Express server.

The API starts only when the database is reachable and required environment
settings are present. Company names are read from `companies`; logo paths and
accent colors can be set in `COMPANY_BRANDING_JSON`, keyed by `company_id`.
Company 1 defaults to the supplied DTDC logo and red accent; other companies
use their own configured branding or a database-name monogram. The login page
intentionally shows platform branding only.

## Existing employee data and authentication

- Sign-in uses `employees.employee_id`; password hashes are verified only on
  the backend with Argon2id. Passwords and hashes are never included in API
  responses. The login password field has an accessible show/hide control.
- The existing `ADMIN` role maps to `COMPANY_ADMIN`, as confirmed for this
  database. Other supported roles retain their existing role names.
- Active hub access is loaded from `employee_hubs` joined to active,
  same-company `hubs`. The inspected `employees.hub_id` values do not match
  those assignments, so authorization uses the foreign-key-backed
  `employee_hubs` relationship rather than trusting that column.
- After credential verification, the API returns the current database role,
  company identity/branding, and active same-company hub assignments. The
  frontend redirects to `/company-admin`, `/operations`, `/hub-manager`, or
  `/logistics-executive` based on that verified role; requested deep links are
  preserved only within that role's workspace. Refresh restores identity from
  the HTTP-only session cookie and `/api/auth/me`, not browser-supplied role or
  company values. Missing hub assignments are not filled in automatically;
  operational workspaces explain that no hub data is available.
- Hub shipment reads require both the matching operational role and an active
  `employee_hubs` assignment to an active hub in the authenticated employee's
  company. `/api/operations/hubs/:hubId/shipments`,
  `/api/hub-manager/hubs/:hubId/shipments`, and
  `/api/logistics-executive/hubs/:hubId/shipments` reject unassigned hubs and
  filter shipments by both company and hub. Company Admin APIs remain
  Company-Admin-only.
- The Operations Manager workspace has overview, shipment search/filter and
  pagination, assigned-hub workload, rule-based delay/stale tracking review,
  read-only assigned staff, route metrics, in-session update notices, and
  reports. Its shipment scope consistently includes records originating at,
  destined for, or whose latest recorded shipment event is at an active hub
  assigned to the authenticated manager. The backend derives assignments from
  `employee_hubs` for every request; submitted employee/company IDs are not
  accepted. Shipment inspection is also scope-checked before event history is
  returned.
- The Hub Manager workspace includes assigned-hub overview, inbound/outbound
  queues, event-confirmed physical inventory, event-backed exceptions, active
  hub staff, configured routes, reports, task assignment from existing shipment
  executive-assignment columns, and a hub-scoped live invalidation
  stream. Shipment reads include records whose origin, destination, or stored
  event history is associated with an active assigned hub. Event-history reads
  are also company-scoped and reject ambiguous consignment numbers because
  `shipment_events` has no company column.
- Hub receipt and dispatch actions validate the authenticated employee's active
  assignment, the shipment's company, the configured route, and its latest
  recorded lifecycle event inside a transaction. They append the existing
  `ARRIVED_AT_DESTINATION_HUB` or `DISPATCHED` event with timestamp and
  responsible employee, then publish a hub-scoped invalidation only after
  commit. They do not change the recorded delivery outcome/SLA fields. Dispatch
  requires a preceding physical origin-hub arrival; inbound receipt requires
  a matching destination and a preceding dispatch. Duplicate or invalid
  transitions are rejected.
- QR/OTP scanning and persistent notification storage are not present.
  Tracking-ID confirmation is used as a clearly labeled manual fallback; it
  does not claim to scan a QR code or verify an OTP. Notifications show stored
  shipment events and non-persistent in-session SSE notices. Historical
  `Delayed` statuses are reported as recorded outcomes, not automatically
  classified as current overdue shipments. Hub inventory requires the latest
  stored event to be a hub-arrival event; origin or destination alone does not
  imply physical presence.
- Shipment assignment already uses the four
  `origin_logistics_executive_{1,2}_id` and
  `destination_logistics_executive_{1,2}_id` fields. The Logistics Executive
  workspace reads those authenticated assignments. A Hub Manager can assign
  eligible work using an existing executive slot; task progress is stored in
  `logistics_task_progress`. Historical shipments are not backfilled into that
  table. The additive migration is
  `backend/migrations/001_create_logistics_task_progress.sql`; review and apply
  it through the approved database deployment process before enabling task
  APIs. It has not been applied automatically by the application.
- The Logistics Executive workspace lists only current, non-final assigned
  pickup and delivery work for the authenticated employee and active assigned
  hubs. Accept/start/fail transitions use `logistics_task_progress`; pickup,
  origin-hub handover, out-for-delivery and delivery append real
  `shipment_events` rows transactionally. Delivery confirmation has a manual
  tracking-ID check because no QR or OTP facility exists. No task progress is
  fabricated from `On Time`/`Delayed` outcomes or missing historical events.
- The Customer Portal provides customer registration/login, shipment booking,
  booking history, tracking search, shipment details, and a timeline of stored
  shipment events. Customer identity is stored separately from employee
  accounts and passwords use Argon2id. Every customer shipment query is scoped
  to the authenticated customer's account and company.
- Customer routes are disabled until `CUSTOMER_PORTAL_COMPANY_ID` is set on
  the API deployment. This server-side setting selects the portal tenant; the
  browser cannot choose a company. Review
  `backend/migrations/002_customer_portal.sql` and apply it only through the
  approved database deployment process. The migration adds customer login and
  booking idempotency tables; it is not applied automatically and has not been
  applied to `logistics_db`.
- Customer bookings create a persisted shipment plus a legitimate `BOOKED`
  event in one transaction. The shipment appears in the existing authorized
  hub workflows and is not automatically assigned to an executive. The current
  schema has route transit days but no booking tariff/rate table, so booking
  prices remain unquoted for operations to confirm. An estimated delivery is
  shown only when the selected configured route contains transit days; it is
  not a delivery commitment. Customer tracking shows only persisted events.

### Migration and deployment checklist

- The application never runs schema migrations automatically. Review and apply
  `backend/migrations/001_create_logistics_task_progress.sql` first, followed
  by `backend/migrations/002_customer_portal.sql`, using the approved database
  deployment process. Migration 002 requires the existing `companies` and
  `customers` tables. Verify both migrations against a disposable clone before
  scheduling production deployment.
- Required API settings are `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
  `DB_PASSWORD`, `JWT_SECRET` (at least 32 characters), `PORT`, and
  `NODE_ENV`. `CUSTOMER_PORTAL_COMPANY_ID` is optional; set it only when the
  Customer Portal is enabled. The server validates that this value is a
  positive integer, but deployment preflight must also confirm that it names
  the intended active company in the configured database. `COMPANY_BRANDING_JSON`
  is optional. Keep credentials and signing keys in the deployment secret
  store, not in source control.
- Migration 001 creates task state only; it does not backfill historic
  shipments. Migration 002 adds customer identity and booking-idempotency
  records. Neither migration has an automated down migration. Dropping the
  task table discards task progress; dropping the customer tables removes
  customer sign-in and idempotency records while already-created core shipment
  and event rows remain. Disable the corresponding APIs and take a restorable
  backup before any rollback. Review and reconcile customer references before
  removing customer identity data. Roll back 002 before 001 when both need to
  be removed.
- Before deployment, confirm the database/schema identity, existing table
  definitions and storage engines, grants for the migration principal, active
  company/hub assignments, environment configuration, backup/restore
  readiness, and migration order. Run backend tests, frontend tests,
  typechecks, and both production builds. Confirm the API does not start against
  an unintended database and verify tenant and hub access using synthetic
  accounts after deployment.
- The API accepts Argon2id hashes only; it has no plaintext comparison
  fallback. The approved migration of the 118 existing employee passwords
  completed and verified the resulting hashes before commit. The migration
  utility is retained for auditability and should not be rerun against the
  migrated values. Its read-only preflight command is:

  ```powershell
  npm run preflight:plaintext-passwords --workspace backend
  ```

  The preflight reports only safe counts and pass/fail results. The migration
  command requires an interactive typed confirmation. It checks the database,
  expected employee count and IDs, password format, InnoDB engine, and absence
  of employee-table triggers. It locks employee rows, updates only
  `employees.password`, verifies each Argon2id hash against the in-memory
  original value, and rolls back on failure. It does not output password
  values, hashes, or employee IDs, and does not alter table definitions or
  database logging settings. Do not rerun it now that the password values are
  hashes.

### Local Company Admin password reset

If the original employee password is unavailable, run the local interactive
reset command from a terminal. It prompts for an Admin Employee ID, requests
the new password twice with masked input, accepts the MySQL password without
echo if `DB_PASSWORD` is unset, and requires a final confirmation. It verifies
the target is an active Admin and the connected database is exactly
`logistics_db`; it updates only `employees.password` and verifies the stored
Argon2id hash in a transaction. The command also uses a session-only minimal
binary-log row image without changing global MySQL settings.

```powershell
npm run reset:admin-password --workspace backend
```

Use a password of at least 12 characters. Do not place the new password in a
command-line argument, environment variable, chat, or source file. Existing
stateless login tokens remain valid until expiry (at most eight hours); sign
out of any active sessions after the reset.

## Workspaces

- `COMPANY_ADMIN` opens a company-scoped dashboard with shipment, SLA, mode,
  route, hub, customer, employee-assignment, revenue-estimate, and recorded
  exception-event summaries. KPI queries and record search take the tenant ID
  from the authenticated employee; the browser cannot select another company.
- The Company Admin sidebar provides separate server-paginated, searchable
  record pages for shipments, customers, employees, hubs, routes, and
  rule-based overdue/recorded exception events. Shipment lists support date,
  status, and mode filters, sortable columns, CSV export for the current page,
  and centred, keyboard-accessible detail dialogs. Company Admin shipment
  access is read-only; status changes must be made through a future
  role-authorized operational workflow. Shipment details show
  recorded events and hub assignments when available; customer and hub details
  include permitted company-scoped contact/assignment and actual historical
  performance data. Employee list rows omit contact details and all
  authentication secrets; employee inspection and management are separate
  actions.
- Company Admin employee management supports adding employees with an Argon2id
  password hash, editing established role/name/contact fields and active hub
  assignments, and deactivating accounts without deleting referenced history.
  Company scope always comes from the authenticated employee; hub IDs are
  validated against active hubs in that company. The API prevents self-role
  changes and deactivation, and preserves at least one active Company Admin.
- Hub assignments are saved per employee in `employee_hubs` and remain fixed
  until an Admin explicitly edits that employee. The Admin assigns hubs through
  the employee's Manage form; there is no automatic or scheduled rotation.
- An AI provider is not configured; the dashboard does not present a
  disconnected assistant as a working feature.
- Dashboard snapshots and visible record pages subscribe to an authenticated,
  company-scoped Server-Sent Events channel. After reconnection or a missed
  in-memory event cursor, the frontend reconciles by refetching the relevant
  data; it does not rely on periodic polling. Operational write handlers must
  use `runCompanyDataTransaction(companyId, eventType, work)` so events publish
  only after commit. The in-process event buffer supports reconnect replay and
  triggers refetch recovery when its cursor has expired. There is still no
  external courier producer or authorized operational shipment-write workflow
  is connected, so imported historical records do not change automatically;
  this is not a live courier feed.
  Power BI, predictive models, editable operational settings,
  and persistent user notifications remain unavailable until their
  tenant-scoped integrations and backend services exist.
- Dashboard values are database snapshots, not live operational metrics.
  Shipment totals use distinct consignment numbers within the selected
  shipment-date range; the default is all available history. Focused ranges up
  to 90 days use daily trends; longer ranges use weekly buckets. On-time
  delivery uses terminal shipments with an actual
  transit value in the denominator and only statuses `On Time`, `Delivered`,
  or `Completed` with actual transit within recorded `sla_days` in the
  numerator. Delay counts require terminal status and actual transit above
  recorded `sla_days`; the explicitly disclosed four-day baseline is only a
  fallback for missing SLA values. At-risk counts are non-terminal shipments
  whose recorded due date has passed. Estimated revenue sums `total_amount`,
  falling back to tariff plus VAS charges only when that amount is null; it is
  not a collection metric, and no currency is configured in the current
  schema. Exception panels show only matching shipment-event records and stay
  empty when no such rows exist.
- The operational status strip, status distribution, mode comparison and
  shipment investigation reflect stored records. Shipment investigation is
  capped to the latest 50 matching shipments and excludes personal phone
  numbers and addresses. Route/hub/status selections apply tenant-scoped
  filters. Last-event data is shown only when an event row exists. A manual
  refresh re-queries the snapshot; it does not turn this historical dataset
  into a live feed.
- Interactive charts use Plotly.js/react-plotly.js (MIT-licensed packages)
  bundled into the frontend. Hover details, legend toggles, zoom/pan and chart
  selection are enabled where relevant.
- The sidebar uses company name, optional company-scoped logo and accent
  configuration. Power BI reports remain marked unconfigured until a
  server-side embed-token integration and report permissions are provided.
- `OPERATIONS_MANAGER`, `HUB_MANAGER`, and `LOGISTICS_EXECUTIVE` have
  role-specific operational workspaces described above. There is no separate
  Super Admin role or UI in the current application.
- There is no role selector or Super Admin UI.

The current database has one populated company (`DTDC`), but every user and
dashboard query is scoped by the authenticated employee's `company_id`; tenant
branding is keyed by company ID and is not hardcoded to DTDC.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

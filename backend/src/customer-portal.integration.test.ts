import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { config } from "./config.js";
import {
  bookCustomerShipment,
  customerPool,
  getCustomerShipment,
  getCustomerShipmentSummary,
  listCustomerShipments,
  loginCustomer,
  registerCustomer,
  CustomerPortalError,
} from "./customer-portal.js";

type Column = RowDataPacket & { column_name: string; data_type: string; column_type: string; is_nullable: "YES" | "NO"; column_default: unknown; extra: string };
const requiredCoreColumns: Record<string, string[]> = {
  companies: ["company_id", "status"],
  customers: ["customer_id", "company_id", "customer_name", "customer_phone", "customer_address", "customer_city", "customer_state", "customer_pincode"],
  hubs: ["hub_id", "company_id", "city", "status"],
  routes: ["route_id", "company_id", "origin_hub_id", "destination_hub_id", "mode", "estimated_transit_days"],
  shipments: ["consignment_no", "company_id", "customer_id", "origin_hub_id", "destination_hub_id", "route_id", "shipment_date", "sender_name", "sender_phone", "sender_address", "sender_city", "sender_state", "sender_pincode", "recipient_name", "recipient_phone", "recipient_address", "recipient_city", "receiver_state", "receiver_pincode", "total_pieces", "actual_weight", "chargeable_weight", "tariff", "vas_charges", "total_amount", "mode", "mode_of_payment", "nature_of_consignment", "estimated_transit_days", "estimated_delivery_date", "delivery_status"],
  shipment_events: ["event_id", "consignment_no", "event_time", "event_type", "event_status", "hub_id", "employee_id", "notes"],
};
const zeroDataTables = [...Object.keys(requiredCoreColumns), "customer_accounts", "customer_booking_requests"];
const createdCompanies: number[] = [];
const createdCustomers: Array<{ companyId: number; customerId: string }> = [];
const createdHubs: Array<{ companyId: number; hubId: string }> = [];
const createdRoutes: Array<{ companyId: number; routeId: string | number }> = [];
const createdShipments: Array<{ companyId: number; consignmentNo: string }> = [];
let fixture: { companyId: number; otherCompanyId: number; historicalCustomerId: string; otherCustomerId: string; originHubId: string; destinationHubId: string; routeId: string | number; historicalConsignment: string; ambiguousPhone: string; token: string } | null = null;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error("Unsafe database identifier in test schema metadata.");
  return `\`${value}\``;
}

async function listTables(): Promise<Set<string>> {
  const [rows] = await customerPool.execute<RowDataPacket[]>("SELECT table_name FROM information_schema.tables WHERE table_schema=?", [config.database.name]);
  return new Set(rows.map((row) => String(row.table_name)));
}

async function columnsFor(table: string): Promise<Column[]> {
  const [rows] = await customerPool.execute<Column[]>("SELECT column_name,data_type,column_type,is_nullable,column_default,extra FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position", [config.database.name, table]);
  return rows;
}

async function tableCount(table: string): Promise<number> {
  const [rows] = await customerPool.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
  return Number(rows[0]?.count ?? 0);
}

async function assertCustomerForeignKeysCanBeCreated(): Promise<void> {
  const [rows] = await customerPool.execute<RowDataPacket[]>(
    `SELECT table_name,column_name,column_type,character_set_name,collation_name
       FROM information_schema.columns
      WHERE table_schema=? AND ((table_name='companies' AND column_name='company_id') OR (table_name='customers' AND column_name IN ('customer_id','company_id')))` ,
    [config.database.name],
  );
  const byKey = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  const companyId = byKey.get("companies.company_id");
  const customerCompanyId = byKey.get("customers.company_id");
  const customerId = byKey.get("customers.customer_id");
  if (!companyId || !customerCompanyId || !customerId) throw new Error("Required company/customer key columns are absent; migration 002 was not applied.");
  if (String(companyId.column_type).toLowerCase() !== "int" || String(customerCompanyId.column_type).toLowerCase() !== "int") {
    throw new Error("Migration 002 declares signed INT company_id keys; the existing company/customer key types do not match.");
  }
  if (String(customerId.column_type).toLowerCase() !== "varchar(20)" || String(customerId.character_set_name).toLowerCase() !== "utf8mb4" || String(customerId.collation_name).toLowerCase() !== "utf8mb4_0900_ai_ci") {
    throw new Error("Migration 002's customer_id VARCHAR(20) utf8mb4_0900_ai_ci foreign key is incompatible with the existing customers.customer_id definition.");
  }
  const [indexes] = await customerPool.execute<RowDataPacket[]>(
    `SELECT index_name,GROUP_CONCAT(column_name ORDER BY seq_in_index) AS indexed_columns,MAX(non_unique) AS non_unique
       FROM information_schema.statistics WHERE table_schema=? AND table_name='customers' GROUP BY index_name`,
    [config.database.name],
  );
  if (!indexes.some((index) => index.indexed_columns === "customer_id" && Number(index.non_unique) === 0)) {
    throw new Error("Migration 002 requires customers.customer_id to be a standalone unique key for its foreign key; no such index exists.");
  }
}

async function applyMigration(path: string): Promise<void> {
  const source = (await readFile(new URL(path, import.meta.url), "utf8"))
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of source) await customerPool.query(statement);
}

async function verifyAndApplyMigrations(): Promise<void> {
  const [versionRows] = await customerPool.query<RowDataPacket[]>("SELECT VERSION() AS version,@@version_comment AS version_comment, DATABASE() AS selected_database");
  const version = String(versionRows[0]?.version ?? "");
  const versionComment = String(versionRows[0]?.version_comment ?? "");
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match || /mariadb/i.test(`${version} ${versionComment}`) || Number(match[1]) < 8 || (Number(match[1]) === 8 && (Number(match[2]) === 0 && (Number(match[3]) < 4)))) {
    throw new Error(`Migrations 002/003/004 require MySQL 8.0.4+ (for utf8mb4_0900_ai_ci and REGEXP_REPLACE); detected ${version || "unknown server"}.`);
  }
  if (String(versionRows[0]?.selected_database) !== config.database.name) throw new Error("Connected database identity does not match LOGIX_TEST_DB_NAME; no writes were made.");
  await assertCustomerForeignKeysCanBeCreated();

  const tables = await listTables();
  const requiredTables = Object.keys(requiredCoreColumns);
  const missingTables = requiredTables.filter((table) => !tables.has(table));
  if (missingTables.length) throw new Error(`A schema-only base database must be provisioned first; missing tables: ${missingTables.join(", ")}. No database was modified.`);
  const missingColumns: string[] = [];
  for (const [table, required] of Object.entries(requiredCoreColumns)) {
    const actual = new Set((await columnsFor(table)).map((column) => column.column_name));
    for (const column of required) if (!actual.has(column)) missingColumns.push(`${table}.${column}`);
  }
  if (missingColumns.length) throw new Error(`The intended application schema is incompatible; required columns missing: ${missingColumns.join(", ")}. No migrations were applied.`);
  for (const table of requiredTables) {
    if (await tableCount(table) !== 0) throw new Error(`Refusing to migrate a non-empty test schema (${table} contains rows). Load schema only and use an empty disposable database.`);
  }
  for (const table of ["customer_accounts", "customer_booking_requests"]) {
    if (tables.has(table) && await tableCount(table) !== 0) throw new Error(`Refusing to run integration tests with pre-existing rows in ${table}; test data must be synthetic and owned by this run.`);
  }

  const hasAccounts = tables.has("customer_accounts");
  const hasRequests = tables.has("customer_booking_requests");
  if (!hasAccounts && !hasRequests) await applyMigration("../migrations/002_customer_portal.sql");
  else if (hasAccounts !== hasRequests) throw new Error("Migration 002 is partially applied in the test database. Recreate the disposable schema; the test runner will not drop tables.");

  const post002 = await listTables();
  if (!post002.has("customer_accounts") || !post002.has("customer_booking_requests")) throw new Error("Migration 002 did not create the expected customer portal tables.");
  for (const [table, expected] of Object.entries({
    customer_accounts: ["customer_account_id", "company_id", "customer_id", "email", "password_hash", "created_at"],
    customer_booking_requests: ["customer_account_id", "idempotency_key", "consignment_no", "created_at"],
  })) {
    const actual = new Set((await columnsFor(table)).map((column) => column.column_name));
    const missing = expected.filter((column) => !actual.has(column));
    if (missing.length) throw new Error(`Migration 002 is missing expected columns in ${table}: ${missing.join(", ")}.`);
  }
  const customerColumns = new Set((await columnsFor("customers")).map((column) => column.column_name));
  if (!customerColumns.has("customer_phone_normalized")) await applyMigration("../migrations/003_customer_first_login.sql");
  else {
    const accountColumns = new Map((await columnsFor("customer_accounts")).map((column) => [column.column_name, column]));
    if (accountColumns.get("email")?.is_nullable !== "YES" || accountColumns.get("password_hash")?.is_nullable !== "YES") throw new Error("Migration 003 is only partially applied to the test database.");
    const [indexes] = await customerPool.execute<RowDataPacket[]>(
      "SELECT index_name,GROUP_CONCAT(column_name ORDER BY seq_in_index) AS indexed_columns FROM information_schema.statistics WHERE table_schema=? AND table_name='customers' GROUP BY index_name",
      [config.database.name],
    );
    if (!indexes.some((index) => index.indexed_columns === "company_id,customer_phone_normalized")) throw new Error("Migration 003's company/phone lookup index is missing from the test database.");
  }
  const requestColumns = new Set((await columnsFor("customer_booking_requests")).map((column) => column.column_name));
  if (!requestColumns.has("booking_request_id")) await applyMigration("../migrations/004_booking_approval_workflow.sql");
  else if (!requestColumns.has("status")) throw new Error("Migration 004 is partially applied in the test database.");
  const finalCustomers = new Set((await columnsFor("customers")).map((column) => column.column_name));
  if (!finalCustomers.has("customer_phone_normalized")) throw new Error("Migration 003 did not add customer_phone_normalized.");
  console.info(`Customer portal test schema ready: ${config.database.name} (${version}); migrations 002, 003, and 004 present.`);
}

type FixtureValue = string | number | Date | null;
function resultField(row: object | undefined, name: string): unknown {
  return row ? (row as Record<string, unknown>)[name] : undefined;
}

async function insertFixture(table: string, proposed: Record<string, FixtureValue>): Promise<{ insertId: number; values: Record<string, FixtureValue> }> {
  const columns = await columnsFor(table);
  const values: Record<string, FixtureValue> = {};
  const missing: string[] = [];
  for (const column of columns) {
    const name = column.column_name;
    const value = proposed[name];
    if (value !== undefined) {
      if (value === null && column.is_nullable !== "YES") missing.push(name);
      else values[name] = value;
      continue;
    }
    if (column.is_nullable === "NO" && column.column_default === null && !/auto_increment|generated/i.test(column.extra)) missing.push(name);
  }
  if (missing.length) throw new Error(`Cannot safely seed synthetic ${table}; required schema fields have no approved fixture values: ${missing.join(", ")}.`);
  const names = Object.keys(values);
  if (!names.length) throw new Error(`No compatible fixture fields were found for ${table}.`);
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(",")}) VALUES (${names.map(() => "?").join(",")})`;
  const parameters = names.map((name) => values[name]!);
  const [result] = await customerPool.execute<ResultSetHeader>(sql, parameters);
  return { insertId: Number(result.insertId), values };
}

async function insertCompany(label: string, companyId: number): Promise<number> {
  const row = await insertFixture("companies", { company_id: companyId, company_name: label, name: label, company_code: `TEST-${label.replace(/\W/g, "-").toUpperCase()}`, status: "ACTIVE", created_at: new Date(), updated_at: new Date() });
  const id = Number(row.values.company_id ?? row.insertId);
  createdCompanies.push(id);
  return id;
}

async function insertCustomer(companyId: number, customerId: string, phone: string, name: string): Promise<void> {
  await insertFixture("customers", { customer_id: customerId, company_id: companyId, customer_name: name, customer_phone: phone, customer_phone_normalized: phone.replace(/\D/g, ""), customer_address: "Synthetic Integration Street", customer_city: "Test City", customer_state: "Test State", customer_pincode: "123456", created_at: new Date(), updated_at: new Date() });
  createdCustomers.push({ companyId, customerId });
}

async function insertHub(companyId: number, requestedHubId: string, city: string): Promise<string> {
  const hubColumn = (await columnsFor("hubs")).find((column) => column.column_name === "hub_id");
  const hubId = hubColumn?.data_type.match(/int|decimal|numeric/) ? 1700000000 + Math.floor(Math.random() * 100000) : requestedHubId;
  const inserted = await insertFixture("hubs", { hub_id: hubId, company_id: companyId, hub_name: `Synthetic ${city} Hub`, name: `Synthetic ${city} Hub`, city, status: "ACTIVE", created_at: new Date(), updated_at: new Date() });
  const storedHubId = String(inserted.values.hub_id);
  createdHubs.push({ companyId, hubId: storedHubId });
  return storedHubId;
}

async function insertRoute(companyId: number, originHubId: string, destinationHubId: string, token: string): Promise<string | number> {
  const columns = await columnsFor("routes");
  const routeColumn = columns.find((column) => column.column_name === "route_id");
  const routeCandidate = routeColumn?.data_type.match(/int|decimal|numeric/) ? 1900000000 + Math.floor(Math.random() * 100000) : `T-${token}`;
  const supplied: Record<string, FixtureValue> = { route_id: routeCandidate, company_id: companyId, origin_hub_id: originHubId, destination_hub_id: destinationHubId, route_name: `Synthetic route ${token}`, mode: "Surface", estimated_transit_days: 3, status: "ACTIVE", created_at: new Date(), updated_at: new Date() };
  const route = await insertFixture("routes", supplied);
  const routeId = route.values.route_id as string | number | undefined;
  if (routeId === undefined) throw new Error("The route fixture did not receive a route_id.");
  createdRoutes.push({ companyId, routeId });
  return routeId;
}

async function insertHistoricalShipment(args: { companyId: number; customerId: string; originHubId: string; destinationHubId: string; routeId: string | number; consignmentNo: string }): Promise<void> {
  await insertFixture("shipments", {
    consignment_no: args.consignmentNo, company_id: args.companyId, customer_id: args.customerId, origin_hub_id: args.originHubId, destination_hub_id: args.destinationHubId, route_id: args.routeId, shipment_date: new Date().toISOString().slice(0, 10),
    sender_name: "Synthetic Sender", sender_phone: "123450001", sender_address: "1 Synthetic Road", sender_city: "Test City", sender_state: "Test State", sender_pincode: "123456",
    recipient_name: "Synthetic Recipient", recipient_phone: "123450002", recipient_address: "2 Synthetic Road", recipient_city: "Test Destination", receiver_state: "Test State", recipient_pincode: "654321",
    total_pieces: 1, actual_weight: 1, chargeable_weight: 1, tariff: null, vas_charges: null, total_amount: null, mode: "Surface", mode_of_payment: "To be confirmed", nature_of_consignment: "Parcel", estimated_transit_days: 3, estimated_delivery_date: null, delivery_status: "Delayed",
  });
  createdShipments.push({ companyId: args.companyId, consignmentNo: args.consignmentNo });
  await insertFixture("shipment_events", { consignment_no: args.consignmentNo, event_time: new Date(), event_type: "BOOKED", event_status: "Booked", hub_id: args.originHubId, employee_id: null, notes: "Synthetic integration fixture: one persisted booking event" });
}

async function cleanupFixtures(): Promise<void> {
  for (const shipment of createdShipments) {
    await customerPool.execute("DELETE FROM shipment_events WHERE consignment_no=?", [shipment.consignmentNo]);
    await customerPool.execute("DELETE FROM shipments WHERE company_id=? AND consignment_no=?", [shipment.companyId, shipment.consignmentNo]);
  }
  for (const customer of createdCustomers) {
    const [accounts] = await customerPool.execute<RowDataPacket[]>("SELECT customer_account_id FROM customer_accounts WHERE company_id=? AND customer_id=?", [customer.companyId, customer.customerId]);
    for (const account of accounts) await customerPool.execute("DELETE FROM customer_booking_requests WHERE customer_account_id=?", [account.customer_account_id]);
    await customerPool.execute("DELETE FROM customer_accounts WHERE company_id=? AND customer_id=?", [customer.companyId, customer.customerId]);
    await customerPool.execute("DELETE FROM customers WHERE company_id=? AND customer_id=?", [customer.companyId, customer.customerId]);
  }
  for (const route of createdRoutes) await customerPool.execute("DELETE FROM routes WHERE company_id=? AND route_id=?", [route.companyId, route.routeId]);
  for (const hub of createdHubs) await customerPool.execute("DELETE FROM hubs WHERE company_id=? AND hub_id=?", [hub.companyId, hub.hubId]);
  for (const companyId of createdCompanies) await customerPool.execute("DELETE FROM companies WHERE company_id=?", [companyId]);
  createdShipments.length = 0; createdCustomers.length = 0; createdRoutes.length = 0; createdHubs.length = 0; createdCompanies.length = 0;
}

before(async () => {
  if (config.databaseMode !== "test") throw new Error("Integration test stopped: set LOGIX_DB_MODE=test and all LOGIX_TEST_DB_* variables. The application .env database is never used as fallback.");
  if (config.customerPortalMode !== "demo") throw new Error("Integration test requires CUSTOMER_PORTAL_MODE=demo to exercise the historical demo setup flow.");
  const token = randomBytes(5).toString("hex").toUpperCase();
  await verifyAndApplyMigrations();
  const companyId = await insertCompany(`Synthetic Test Company ${token}`, 1900000000 + Math.floor(Math.random() * 100000));
  const otherCompanyId = await insertCompany(`Synthetic Other Company ${token}`, 1800000000 + Math.floor(Math.random() * 100000));
  const originHubId = await insertHub(companyId, `T${token}O`, "Test Origin");
  const destinationHubId = await insertHub(companyId, `T${token}D`, "Test Destination");
  const routeId = await insertRoute(companyId, originHubId, destinationHubId, token);
  const historicalCustomerId = `C${token}HIST`;
  const otherCustomerId = `C${token}OTHER`;
  const otherTenantCustomerId = `C${token}TENANT`;
  const ambiguousPhone = `55${String((randomBytes(4).readUInt32BE(0) % 900000) + 10000).slice(0, 3)}`;
  await insertCustomer(companyId, historicalCustomerId, "12345", "Synthetic Historical Customer");
  await insertCustomer(companyId, otherCustomerId, "67890", "Synthetic Other Customer");
  await insertCustomer(companyId, `C${token}AMB1`, ambiguousPhone, "Synthetic Ambiguous One");
  await insertCustomer(companyId, `C${token}AMB2`, ambiguousPhone, "Synthetic Ambiguous Two");
  await insertCustomer(otherCompanyId, otherTenantCustomerId, "44556", "Synthetic Other Tenant Customer");
  const historicalConsignment = `LXTEST${token}H`;
  await insertHistoricalShipment({ companyId, customerId: historicalCustomerId, originHubId, destinationHubId, routeId, consignmentNo: historicalConsignment });
  fixture = { companyId, otherCompanyId, historicalCustomerId, otherCustomerId, originHubId, destinationHubId, routeId, historicalConsignment, ambiguousPhone, token };
});

after(async () => {
  try {
    if (config.databaseMode === "test") await cleanupFixtures();
  } finally {
    await customerPool.end();
  }
});

test("historical name login, history, booking, replay, and tenant ownership use isolated MySQL", async () => {
  assert.ok(fixture, "test database fixtures were seeded");
  const f = fixture!;
  const password = "Synthetic Historical Customer";
  const customer = await loginCustomer(f.companyId, "12-345", password);
  assert.ok(customer);
  assert.equal(customer.customerId, f.historicalCustomerId);
  assert.equal(Object.hasOwn(customer, "password_hash"), false);
  assert.equal(await loginCustomer(f.companyId, "2345", password), null);
  assert.equal(await loginCustomer(f.companyId, "88888", password), null);
  assert.equal(await loginCustomer(f.companyId, f.ambiguousPhone, password), null);
  assert.equal((await loginCustomer(f.companyId, "12 345", password))?.customerId, f.historicalCustomerId);
  const [hashRows] = await customerPool.execute<RowDataPacket[]>("SELECT password_hash FROM customer_accounts WHERE company_id=? AND customer_id=?", [f.companyId, f.historicalCustomerId]);
  assert.match(String(hashRows[0]?.password_hash), /^\$argon2id\$/);
  assert.equal((await loginCustomer(f.companyId, "12 345", password))?.customerId, f.historicalCustomerId);

  const historical = await listCustomerShipments(f.companyId, f.historicalCustomerId, { page: 1, pageSize: 10 });
  assert.equal(historical.pagination.total, 1);
  assert.equal(resultField(historical.shipments[0], "consignmentNo"), f.historicalConsignment);
  assert.equal(resultField(historical.shipments[0], "status"), "BOOKED");
  assert.equal(resultField(historical.shipments[0], "recordedOutcome"), "Delayed");
  const detail = await getCustomerShipment(f.companyId, f.historicalCustomerId, f.historicalConsignment);
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0]?.eventType, "BOOKED");

  const registered = await registerCustomer(f.companyId, {
    email: `synthetic-${f.token.toLowerCase()}@example.invalid`, password,
    confirmPassword: password,
    name: "Synthetic New Customer", phone: "+91 9000001234", address: "3 Synthetic Road", city: "Test City", state: "Test State", pincode: "123456",
  });
  createdCustomers.push({ companyId: f.companyId, customerId: registered.customerId });
  await assert.rejects(() => registerCustomer(f.companyId, {
    email: `duplicate-${f.token.toLowerCase()}@example.invalid`, password,
    confirmPassword: password,
    name: "Synthetic Duplicate Customer", phone: "+91 9000001234", address: "6 Synthetic Road", city: "Test City", state: "Test State", pincode: "123456",
  }), (error: unknown) => error instanceof CustomerPortalError && error.statusCode === 409);
  const input = {
    idempotencyKey: "e72d3225-23bc-4a65-b802-4ddfd1b16c61",
    originHubId: f.originHubId, destinationHubId: f.destinationHubId, mode: "Surface", pieces: 1, weightKg: 2, chargePayer: "SENDER" as const,
    sender: { name: "Synthetic Sender", phone: "+91 9000001001", address: "4 Synthetic Road", city: "Test City", state: "Test State", pincode: "123456" },
    recipient: { name: "Synthetic Recipient", phone: "+91 9000001002", address: "5 Synthetic Road", city: "Other City", state: "Test State", pincode: "654321" },
  };
  const booking = await bookCustomerShipment(f.companyId, registered.customerId, registered.accountId, input);
  const replay = await bookCustomerShipment(f.companyId, registered.customerId, registered.accountId, input);
  assert.equal(resultField(replay, "bookingRequestId"), resultField(booking, "bookingRequestId"), "idempotent replay returns the original pending request");
  assert.equal(resultField(booking, "status"), "PENDING_APPROVAL");
  const registeredShipments = await listCustomerShipments(f.companyId, registered.customerId, { page: 1, pageSize: 10 });
  assert.equal(registeredShipments.pagination.total, 0, "pending request must not become an active shipment");
  assert.equal((await getCustomerShipmentSummary(f.companyId, registered.customerId)).total, 0);
  assert.equal((await loginCustomer(f.companyId, "+91 9000001234", password))?.customerId, registered.customerId);

  assert.equal((await listCustomerShipments(f.companyId, f.otherCustomerId)).pagination.total, 0);
  await assert.rejects(() => getCustomerShipment(f.companyId, f.otherCustomerId, f.historicalConsignment), (error: unknown) => error instanceof CustomerPortalError && error.statusCode === 404);
  await assert.rejects(() => getCustomerShipment(f.otherCompanyId, `C${f.token}TENANT`, f.historicalConsignment), (error: unknown) => error instanceof CustomerPortalError && error.statusCode === 404);
  assert.equal((await listCustomerShipments(f.otherCompanyId, `C${f.token}TENANT`)).pagination.total, 0);
});

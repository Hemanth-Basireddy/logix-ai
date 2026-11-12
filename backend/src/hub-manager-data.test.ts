import assert from "node:assert/strict";
import test from "node:test";
import type { FieldPacket, QueryResult } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import {
  getHubManagerWorkspace,
  HubManagerDataError,
  hubManagerShipmentFiltersSchema,
  listHubManagerShipments,
  recordHubShipmentAction,
} from "./hub-manager-data.js";

test("Hub Manager shipment filter defaults and empty optional filters are valid for both queues", () => {
  for (const view of ["inbound", "outbound"] as const) {
    const parsed = hubManagerShipmentFiltersSchema.safeParse({
      view,
      from: "",
      to: "",
      search: "",
      status: "",
      hubId: "",
      assignment: "",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.view, view);
      assert.equal(parsed.data.page, 1);
      assert.equal(parsed.data.pageSize, 25);
      assert.equal(parsed.data.from, undefined);
      assert.equal(parsed.data.to, undefined);
    }
  }
  assert.equal(hubManagerShipmentFiltersSchema.safeParse({ view: "inbound" }).success, true);
  assert.equal(hubManagerShipmentFiltersSchema.safeParse({ view: "outbound" }).success, true);
});

test("Hub Manager accepts valid status, assignment, date, search, and hub filters but rejects invalid values", () => {
  const valid = hubManagerShipmentFiltersSchema.safeParse({
    view: "inbound",
    status: "IN_TRANSIT",
    assignment: "ASSIGNED",
    from: "2026-10-01",
    to: "2026-10-18",
    search: "TRACK-100",
    hubId: "AGR-H01",
  });
  assert.equal(valid.success, true);
  assert.equal(hubManagerShipmentFiltersSchema.safeParse({ view: "outbound", assignment: "SOMETHING" }).success, false);
  assert.equal(hubManagerShipmentFiltersSchema.safeParse({ view: "inbound", from: "yesterday" }).success, false);
  assert.equal(hubManagerShipmentFiltersSchema.safeParse({ view: "Inbound" }).success, false);
});

function mockExecutor(results: unknown[]) {
  const calls: Array<{ sql: string; values: unknown }> = [];
  const executor = {
    execute: async <T extends QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]> => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      return [results.shift() as T, []];
    },
  } as unknown as PoolConnection;
  return { executor, calls };
}

test("Hub Manager with no assigned hubs receives an empty workspace without company-wide data", async () => {
  const { executor, calls } = mockExecutor([[]]);
  const data = await getHubManagerWorkspace(executor, 65, "HUB-MGR-1");
  assert.equal(calls.length, 1);
  assert.deepEqual(data.hubs, []);
  assert.equal(data.kpis.shipments, 0);
  assert.equal(data.capabilities.taskAssignments, false);
  assert.equal(data.capabilities.qrScanning, true);
});

test("Hub Manager shipment reads enforce assigned hub filters in the backend", async () => {
  const { executor, calls } = mockExecutor([
    [{ hubId: "HUB-1", city: "North" }],
    [{ total: 0 }],
    [],
  ]);
  const page = await listHubManagerShipments(executor, 65, "HUB-MGR-1", {
    page: 1,
    pageSize: 25,
    search: "",
    status: "",
    hubId: "HUB-1",
    view: "all",
  });
  assert.equal(page.total, 0);
  assert.match(calls[1]!.sql, /s\.company_id = \?/);
  assert.match(calls[1]!.sql, /assigned_hub_event\.hub_id = \?/);

  const unauthorized = mockExecutor([[{ hubId: "HUB-1", city: "North" }]]);
  await assert.rejects(
    listHubManagerShipments(unauthorized.executor, 65, "HUB-MGR-1", {
      page: 1,
      pageSize: 25,
      search: "",
      status: "",
      hubId: "HUB-OTHER",
      view: "all",
    }),
    (error: unknown) => error instanceof HubManagerDataError && error.statusCode === 403,
  );
  assert.equal(unauthorized.calls.length, 1);

  const secondManager = mockExecutor([[{ hubId: "HUB-2", city: "South" }]]);
  await assert.rejects(
    listHubManagerShipments(secondManager.executor, 65, "HUB-MGR-2", {
      page: 1,
      pageSize: 25,
      search: "",
      status: "",
      hubId: "HUB-1",
      view: "all",
    }),
    (error: unknown) => error instanceof HubManagerDataError && error.statusCode === 403,
  );
  assert.equal(secondManager.calls.length, 1);
});

test("inbound and outbound queue queries load without filters and apply assignment and date filters", async () => {
  for (const view of ["inbound", "outbound"] as const) {
    const emptyFilterParse = hubManagerShipmentFiltersSchema.safeParse({ view, from: "", to: "" });
    assert.equal(emptyFilterParse.success, true);
    if (!emptyFilterParse.success) continue;
    const empty = mockExecutor([
      [{ hubId: "HUB-1", city: "North" }],
      [{ total: 0 }],
      [],
    ]);
    const emptyPage = await listHubManagerShipments(empty.executor, 65, "HUB-MGR-1", emptyFilterParse.data);
    assert.deepEqual(emptyPage.shipments, []);
    assert.equal(emptyPage.total, 0);
    assert.match(empty.calls[1]!.sql, view === "inbound" ? /ARRIVED_AT_DESTINATION_HUB/ : /RECEIVED_AT_ORIGIN_HUB/);

    const validFilterParse = hubManagerShipmentFiltersSchema.safeParse({
      view,
      status: "IN_TRANSIT",
      assignment: "ASSIGNED",
      from: "2026-10-01",
      to: "2026-10-18",
      search: "TRACK-100",
      hubId: "HUB-1",
    });
    assert.equal(validFilterParse.success, true);
    if (!validFilterParse.success) continue;
    const filtered = mockExecutor([
      [{ hubId: "HUB-1", city: "North" }],
      [{ total: 0 }],
      [],
    ]);
    await listHubManagerShipments(filtered.executor, 65, "HUB-MGR-1", validFilterParse.data);
    assert.match(filtered.calls[1]!.sql, /s\.delivery_status = \?/);
    assert.match(filtered.calls[1]!.sql, /DATE\(s\.shipment_date\) >= \?/);
    assert.match(filtered.calls[1]!.sql, /DATE\(s\.shipment_date\) <= \?/);
    assert.match(filtered.calls[1]!.sql, /s\.consignment_no LIKE \?/);
    assert.match(filtered.calls[1]!.sql, view === "inbound"
      ? /s\.destination_logistics_executive_1_id IS NOT NULL/
      : /s\.origin_logistics_executive_1_id IS NOT NULL/);
  }
});

test("inbound and outbound queues bind lifecycle state to the selected authorized hub", async () => {
  for (const view of ["inbound", "outbound"] as const) {
    const { executor, calls } = mockExecutor([
      [{ hubId: "HUB-1", city: "North" }, { hubId: "HUB-2", city: "South" }],
      [{ total: 0 }],
      [],
    ]);
    await listHubManagerShipments(executor, 65, "HUB-MGR-1", {
      page: 1, pageSize: 25, search: "", status: "", hubId: "HUB-2", view,
    });
    const countSql = calls[1]!.sql;
    assert.match(countSql, /s\.company_id = \?/);
    assert.match(countSql, view === "inbound" ? /ARRIVED_AT_DESTINATION_HUB/ : /RECEIVED_AT_ORIGIN_HUB/);
    assert.deepEqual((calls[1]!.values as unknown[]).slice(view === "inbound" ? -2 : -1), view === "inbound" ? ["HUB-2", "HUB-2"] : ["HUB-2"]);
    assert.match(calls[2]!.sql, /recipient_name AS recipientName/);
    assert.match(calls[2]!.sql, /nextAction/);
  }
});

test("authorized inbound arrival is persisted separately from physical receipt", async () => {
  const { executor, calls } = mockExecutor([
    [{ assigned: 1 }],
    [{ consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "ROUTE-1" }],
    [{ eventType: "DISPATCHED", hubId: "HUB-1" }],
    [{ route_id: "ROUTE-1" }],
    { affectedRows: 1 },
  ]);
  const result = await recordHubShipmentAction(executor, 65, "HUB-MGR-1", "HUB-2", "TRACK-1", "arrive");
  assert.deepEqual(result, {
    consignmentNo: "TRACK-1",
    eventType: "ARRIVED_AT_DESTINATION_HUB",
    hubId: "HUB-2",
  });
  assert.match(calls[4]!.sql, /INSERT INTO shipment_events/);
  assert.deepEqual(calls[4]!.values, ["TRACK-1", "ARRIVED_AT_DESTINATION_HUB", "HUB-2", "HUB-MGR-1"]);
});

test("duplicate physical receipt and wrong-hub scans are rejected without inserting events", async () => {
  const duplicate = mockExecutor([
    [{ assigned: 1 }],
    [{ consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "ROUTE-1" }],
    [{ eventType: "RECEIVED_AT_DESTINATION_HUB", hubId: "HUB-2" }],
    [{ route_id: "ROUTE-1" }],
  ]);
  await assert.rejects(
    recordHubShipmentAction(duplicate.executor, 65, "HUB-MGR-1", "HUB-2", "TRACK-1", "receive"),
    (error: unknown) => error instanceof HubManagerDataError && error.statusCode === 409,
  );
  assert.equal(duplicate.calls.length, 4);

  const wrongHub = mockExecutor([[]]);
  await assert.rejects(
    recordHubShipmentAction(wrongHub.executor, 65, "HUB-MGR-1", "HUB-OTHER", "TRACK-1", "receive"),
    (error: unknown) => error instanceof HubManagerDataError && error.statusCode === 403,
  );
  assert.equal(wrongHub.calls.length, 1);
});

test("origin hub manager records arrival after executive handover", async () => {
  const { executor, calls } = mockExecutor([
    [{ assigned: 1 }],
    [{ consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "ROUTE-1" }],
    [{ eventType: "HANDED_OVER_AT_ORIGIN_HUB", hubId: "HUB-1" }],
    [{ route_id: "ROUTE-1" }],
    { affectedRows: 1 },
  ]);
  const result = await recordHubShipmentAction(executor, 65, "HUB-MGR-1", "HUB-1", "TRACK-1", "arrive");
  assert.equal(result.eventType, "ARRIVED_AT_ORIGIN_HUB");
  assert.deepEqual(calls[4]!.values, ["TRACK-1", "ARRIVED_AT_ORIGIN_HUB", "HUB-1", "HUB-MGR-1"]);
});

test("dispatch requires a separate physical receipt event and the configured company route", async () => {
  const { executor, calls } = mockExecutor([
    [{ assigned: 1 }],
    [{ consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "ROUTE-1" }],
    [{ eventType: "RECEIVED_AT_ORIGIN_HUB", hubId: "HUB-1" }],
    [{ route_id: "ROUTE-1" }],
    { affectedRows: 1 },
  ]);
  const result = await recordHubShipmentAction(executor, 65, "HUB-MGR-1", "HUB-1", "TRACK-1", "dispatch");
  assert.equal(result.eventType, "DISPATCHED");
  assert.match(calls[3]!.sql, /origin_hub_id = \? AND destination_hub_id = \?/);
  assert.deepEqual(calls[4]!.values, ["TRACK-1", "DISPATCHED", "HUB-1", "HUB-MGR-1"]);

  const notReceived = mockExecutor([
    [{ assigned: 1 }],
    [{ consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "ROUTE-1" }],
    [{ eventType: "ARRIVED_AT_ORIGIN_HUB", hubId: "HUB-1" }],
    [{ route_id: "ROUTE-1" }],
  ]);
  await assert.rejects(
    recordHubShipmentAction(notReceived.executor, 65, "HUB-MGR-1", "HUB-1", "TRACK-1", "dispatch"),
    (error: unknown) => error instanceof HubManagerDataError && error.statusCode === 409,
  );
  assert.equal(notReceived.calls.length, 4);
});

test("physical receipt cannot be recorded before a persisted arrival", async () => {
  const { executor, calls } = mockExecutor([
    [{ assigned: 1 }],
    [{ consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "ROUTE-1" }],
    [{ eventType: "DISPATCHED", hubId: "HUB-1" }],
    [{ route_id: "ROUTE-1" }],
  ]);
  await assert.rejects(
    recordHubShipmentAction(executor, 65, "HUB-MGR-1", "HUB-2", "TRACK-1", "receive"),
    (error: unknown) => error instanceof HubManagerDataError && error.statusCode === 409,
  );
  assert.equal(calls.length, 4);
});

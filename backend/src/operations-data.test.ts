import assert from "node:assert/strict";
import test from "node:test";
import type { FieldPacket, QueryResult } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import {
  getOperationsShipmentEvents,
  getOperationsWorkspace,
  listOperationsShipments,
} from "./operations-data.js";

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

const filters = {
  page: 1,
  pageSize: 25,
  search: "",
  status: "",
  hubId: "",
  origin: "",
  destination: "",
  mode: "",
  risk: "" as const,
  sortBy: "shipmentDate" as const,
  direction: "desc" as const,
};

test("shipment list uses only the authenticated manager's assigned hubs and includes latest-event scope", async () => {
  const { executor, calls } = mockExecutor([
    [{ hubId: "HUB-A", city: "Alpha" }, { hubId: "HUB-B", city: "Beta" }, { hubId: "HUB-C", city: "Gamma" }],
    [{ total: 1 }],
    [{
      consignmentNo: "SHIP-1",
      customerName: "Customer",
      origin: "Alpha",
      destination: "Remote",
      originHubId: "HUB-A",
      destinationHubId: "HUB-X",
      mode: "Air",
      chargeableWeight: 2,
      shipmentDate: "2026-10-01",
      expectedDeliveryDate: null,
      status: "In Transit",
      slaDueDate: null,
      lastEventAt: null,
      lastEvent: null,
      lastLocation: null,
    }],
  ]);

  const result = await listOperationsShipments(executor, 1, "OPS-A", filters);

  assert.equal(result.total, 1);
  assert.equal(result.shipments[0]?.consignmentNo, "SHIP-1");
  assert.match(calls[0]!.sql, /employee_id = \?/);
  assert.deepEqual(calls[0]!.values, [1, "OPS-A"]);
  assert.match(calls[1]!.sql, /origin_hub_id IN \(\?, \?, \?\)/);
  assert.match(calls[1]!.sql, /destination_hub_id IN \(\?, \?, \?\)/);
  assert.match(calls[1]!.sql, /FROM shipment_events current_event/);
  assert.deepEqual(calls[1]!.values, [1, "HUB-A", "HUB-B", "HUB-C", "HUB-A", "HUB-B", "HUB-C", "HUB-A", "HUB-B", "HUB-C"]);
});

test("manager cannot filter shipment reads to another manager's hub", async () => {
  const { executor, calls } = mockExecutor([
    [{ hubId: "HUB-A", city: "Alpha" }, { hubId: "HUB-B", city: "Beta" }, { hubId: "HUB-C", city: "Gamma" }],
  ]);

  const result = await listOperationsShipments(executor, 1, "OPS-A", {
    ...filters,
    hubId: "HUB-OTHER",
  });

  assert.deepEqual(result.shipments, []);
  assert.equal(result.total, 0);
  assert.equal(calls.length, 1);
});

test("manager with no assignments receives an explicit empty scoped workspace", async () => {
  const { executor, calls } = mockExecutor([[]]);
  const result = await getOperationsWorkspace(executor, 1, "OPS-NO-HUB");

  assert.equal(result.scope.assignedHubCount, 0);
  assert.deepEqual(result.hubs, []);
  assert.deepEqual(result.kpis, {
    totalShipments: 0,
    inTransit: 0,
    delayed: 0,
    approachingSla: 0,
    staleTracking: 0,
  });
  assert.equal(result.capabilities.taskAssignments, false);
  assert.equal(calls.length, 1);
});

test("recorded DELIVERED events are excluded from active Operations Manager KPIs", async () => {
  const calls: string[] = [];
  const executor = {
    execute: async <T extends QueryResult>(sql: string): Promise<[T, FieldPacket[]]> => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push(normalized);
      if (normalized.includes("SELECT h.hub_id AS hubId, h.city")) {
        return [[{ hubId: "HUB-A", city: "Alpha" }] as unknown as T, []];
      }
      if (normalized.includes("AS inTransit")) {
        return [[{ total: 2, inTransit: 1, delayedCount: 0, approachingSla: 0, staleTracking: 0 }] as unknown as T, []];
      }
      return [[] as unknown as T, []];
    },
  } as unknown as PoolConnection;

  const result = await getOperationsWorkspace(executor, 1, "OPS-A");
  const summarySql = calls.find((sql) => sql.includes("AS inTransit"));

  assert.equal(result.kpis.totalShipments, 2);
  assert.equal(result.kpis.inTransit, 1);
  assert.match(summarySql ?? "", /latest\.event_type/);
  assert.match(summarySql ?? "", /COALESCE\(latest\.event_type, ''\) <> 'DELIVERED'/);
});

test("another manager cannot inspect a shipment outside their assigned hubs", async () => {
  const { executor, calls } = mockExecutor([
    [{ hubId: "HUB-X", city: "X" }, { hubId: "HUB-Y", city: "Y" }, { hubId: "HUB-Z", city: "Z" }],
    [],
  ]);

  const result = await getOperationsShipmentEvents(executor, 1, "OPS-B", "SHIP-OWNED-BY-OPS-A");

  assert.equal(result, null);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.sql, /s\.company_id = \?/);
  assert.match(calls[1]!.sql, /origin_hub_id IN \(\?, \?, \?\)/);
  assert.deepEqual(calls[1]!.values, [
    1,
    "SHIP-OWNED-BY-OPS-A",
    "HUB-X", "HUB-Y", "HUB-Z",
    "HUB-X", "HUB-Y", "HUB-Z",
    "HUB-X", "HUB-Y", "HUB-Z",
  ]);
});

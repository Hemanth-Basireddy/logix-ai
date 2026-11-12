import assert from "node:assert/strict";
import test from "node:test";
import type { FieldPacket, QueryResult } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { TransportError, arriveTransportTrip, createTransportTrip, dispatchTransportTrip, reconcileTransportShipment } from "./transport.js";

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

test("trip creation accepts multiple physically received shipments and persists a single manifest", async () => {
  const { executor, calls } = mockExecutor([
    [{ allowed: 1 }], [{ active: 1 }], [{ route: 1 }],
    [{ consignmentNo: "LX-1", originHubId: "H1", destinationHubId: "H3", deliveryStatus: "Booked" }],
    [{ eventType: "RECEIVED_AT_ORIGIN_HUB", hubId: "H1" }], [],
    [{ consignmentNo: "LX-2", originHubId: "H2", destinationHubId: "H3", deliveryStatus: "Booked" }],
    [{ eventType: "RECEIVED_AT_HUB", hubId: "H1" }], [],
    { insertId: 42 }, {},
    {}, {}, {}, {}, {}, {},
  ]);
  const result = await createTransportTrip(executor, {
    companyId: 9, employeeId: "HM-1", originHubId: "H1", destinationHubId: "H2",
    vehicleNumber: "KA-01-AB-1234", driverName: "Test Driver", consignmentNos: ["LX-1", "LX-2"],
  });
  assert.deepEqual(result, { tripId: 42, status: "PLANNED", shipmentCount: 2, consignmentNos: ["LX-1", "LX-2"] });
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO transport_trip_shipments")).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO shipment_events")).length, 2);
});

test("trip creation rejects shipments without a persisted receipt at its origin", async () => {
  const { executor, calls } = mockExecutor([
    [{ allowed: 1 }], [{ active: 1 }], [{ route: 1 }],
    [{ consignmentNo: "LX-1", originHubId: "H1", destinationHubId: "H3", deliveryStatus: "Booked" }],
    [{ eventType: "PICKED_UP", hubId: null }],
  ]);
  await assert.rejects(createTransportTrip(executor, {
    companyId: 9, employeeId: "HM-1", originHubId: "H1", destinationHubId: "H2",
    vehicleNumber: "KA-01-AB-1234", driverName: "Test Driver", consignmentNos: ["LX-1"],
  }), (error: unknown) => error instanceof TransportError && error.statusCode === 409);
  assert.equal(calls.some((call) => call.sql.startsWith("INSERT INTO transport_trips")), false);
});

test("a trip cannot dispatch before all manifest shipments are loaded", async () => {
  const { executor, calls } = mockExecutor([[{ trip_id: 42, origin_hub_id: "H1", destination_hub_id: "H2", status: "LOADING" }], [{ allowed: 1 }]]);
  await assert.rejects(dispatchTransportTrip(executor, { companyId: 9, employeeId: "HM-1", tripId: 42 }), (error: unknown) => error instanceof TransportError && error.statusCode === 409);
  assert.equal(calls.length, 2);
});

test("trip arrival records arrival without automatically receiving manifest packages", async () => {
  const { executor, calls } = mockExecutor([
    [{ trip_id: 42, origin_hub_id: "H1", destination_hub_id: "H2", status: "IN_TRANSIT" }], [{ allowed: 1 }], {}, {},
    [{ consignmentNo: "LX-1" }], [{ destinationHubId: "H2" }], {},
  ]);
  const result = await arriveTransportTrip(executor, { companyId: 9, employeeId: "HM-2", tripId: 42 });
  assert.equal(result.physicalReceiptRequired, true);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE transport_trip_shipments SET loading_status='RECEIVED'")), false);
  assert.ok(calls.some((call) => Array.isArray(call.values) && call.values.includes("ARRIVED_AT_DESTINATION_HUB")));
});

test("arrival reconciliation requires a reason for missing packages and closes only when all are resolved", async () => {
  const invalid = mockExecutor([[{ trip_id: 42, origin_hub_id: "H1", destination_hub_id: "H2", status: "ARRIVED" }], [{ allowed: 1 }]]);
  await assert.rejects(reconcileTransportShipment(invalid.executor, {
    companyId: 9, employeeId: "HM-2", tripId: 42, consignmentNo: "LX-1", condition: "MISSING",
  }), (error: unknown) => error instanceof TransportError && error.statusCode === 400);
  assert.equal(invalid.calls.length, 2);

  const { executor, calls } = mockExecutor([
    [{ trip_id: 42, origin_hub_id: "H1", destination_hub_id: "H2", status: "ARRIVED" }], [{ allowed: 1 }],
    [{ loadingStatus: "LOADED" }], [{ destinationHubId: "H2" }], {}, {}, [{ pending: 0 }], {}, {},
  ]);
  const result = await reconcileTransportShipment(executor, {
    companyId: 9, employeeId: "HM-2", tripId: 42, consignmentNo: "LX-1", condition: "MISSING", reason: "Manifest item not found at offload.",
  });
  assert.equal(result.tripClosed, true);
  assert.ok(calls.some((call) => Array.isArray(call.values) && call.values.includes("SHIPMENT_MISSING")));
  assert.ok(calls.some((call) => call.sql.includes("UPDATE transport_trips SET status='CLOSED'")));
});

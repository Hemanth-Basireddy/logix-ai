import assert from "node:assert/strict";
import test from "node:test";
import type { FieldPacket, QueryResult } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { HubAccessError, listAssignedHubShipments } from "./role-hub-data.js";

function mockExecutor(results: unknown[]) {
  const calls: Array<{ sql: string; values: unknown }> = [];
  const executor = {
    execute: async <T extends QueryResult>(
      sql: string,
      values?: unknown,
    ): Promise<[T, FieldPacket[]]> => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      return [results.shift() as T, []];
    },
  } as unknown as PoolConnection;
  return { executor, calls };
}

test("hub shipments reject unassigned hubs before querying shipment data", async () => {
  const { executor, calls } = mockExecutor([[]]);

  await assert.rejects(
    listAssignedHubShipments(executor, 65, "OPS-1", "HUB-OUTSIDE"),
    HubAccessError,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /e\.company_id = \?/);
  assert.match(calls[0]!.sql, /h\.company_id = e\.company_id/);
  assert.match(calls[0]!.sql, /eh\.hub_id = \?/);
  assert.deepEqual(calls[0]!.values, [65, "OPS-1", "HUB-OUTSIDE"]);
});

test("hub shipment data is limited to the authenticated company and assigned hub", async () => {
  const { executor, calls } = mockExecutor([
    [{ assigned: 1 }],
    [{
      consignmentNo: "SHIP-1",
      shipmentDate: "2026-10-01",
      status: "In Transit",
      origin: "Hub A",
      destination: "Hub B",
      mode: "Air",
    }],
  ]);

  const rows = await listAssignedHubShipments(executor, 65, "OPS-1", "HUB-1");

  assert.equal(rows.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.values, [65, "HUB-1", "HUB-1"]);
  assert.match(calls[1]!.sql, /WHERE s\.company_id = \?/);
  assert.match(calls[1]!.sql, /s\.origin_hub_id = \? OR s\.destination_hub_id = \?/);
  assert.match(calls[1]!.sql, /LIMIT 100/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { getCustomerDashboardSummary } from "./customer-dashboard.js";

function mockExecutor(results: unknown[]) {
  const calls: Array<{ sql: string; values: unknown }> = [];
  const executor = {
    execute: async <T>(sql: string, values?: unknown) => {
      calls.push({ sql, values });
      return [results.shift(), []] as unknown as T;
    },
  } as unknown as import("mysql2/promise").Pool;
  return { executor, calls };
}

test("dashboard keeps company network aggregates separate from customer activity", async () => {
  const { executor, calls } = mockExecutor([
    [{ total: "49629", delivered: "32100", active: "500", customersServed: "42000" }],
    [{ total: "26" }],
    [{ total: "35" }],
    [{ origin: "Telangana", destination: "Maharashtra", shipments: "1284", delivered: "1190", active: "12" }],
    [{ destination: "Maharashtra", shipments: "2200", delivered: "2010", active: "34" }],
    [{ destination: "Maharashtra", hubId: "H2", city: "Mumbai", shipments: "1800" }],
    [{ month: "2026-10", shipments: "700" }],
    [{ total: "4", delivered: "2", active: "1", exceptions: "0", awaitingEvent: "1" }],
    [{ total: "3" }],
    [{ origin: "Hyderabad", destination: "Bengaluru", shipments: "3", delivered: "2", active: "1" }],
    [{ month: "2026-10", shipments: "2" }],
    [{ total: "1" }],
    [{ consignmentNo: "LX1", shipmentDate: new Date("2026-10-01T00:00:00Z"), originHubId: "H1", destinationHubId: "H2", mode: "SURFACE", status: "DELIVERED", lastEventAt: new Date("2026-10-02T00:00:00Z"), totalAmount: "125.50" }],
  ]);

  const result = await getCustomerDashboardSummary(executor, 7, "CUS-7");
  assert.deepEqual(result, {
    companyNetwork: {
      totalShipments: 49629, deliveredShipments: 32100, activeShipments: 500,
      customersServed: 42000, statesCovered: 26, hubsCovered: 35,
      monthlyShipmentActivity: [{ month: "2026-10", shipments: 700 }],
      destinationSummary: [{ destination: "Maharashtra", shipments: 2200, delivered: 2010, active: 34, hubs: [{ hubId: "H2", city: "Mumbai", shipments: 1800 }] }],
      routeSummary: [{ origin: "Telangana", destination: "Maharashtra", shipments: 1284, delivered: 1190, active: 12 }],
    },
    personal: {
      totalShipments: 4, deliveredShipments: 2, activeShipments: 1, exceptionShipments: 0,
      awaitingEvent: 1, pendingApproval: 1, statesCovered: 3,
      topRoutes: [{ origin: "Hyderabad", destination: "Bengaluru", shipments: 3, delivered: 2, active: 1 }],
      monthlyActivity: [{ month: "2026-10", shipments: 2 }],
    },
    recentShipments: [{
      consignmentNo: "LX1", shipmentDate: "2026-10-01T00:00:00.000Z", originHubId: "H1",
      destinationHubId: "H2", mode: "SURFACE", status: "DELIVERED",
      lastEventAt: "2026-10-02T00:00:00.000Z", totalAmount: 125.5,
    }],
  });

  const companyQueries = calls.slice(0, 7);
  assert.ok(companyQueries.every((call) => JSON.stringify(call.values) === "[7]" || JSON.stringify(call.values) === "[7,7]"));
  assert.ok(companyQueries.every((call) => !JSON.stringify(call.values).includes("CUS-7")));
  assert.match(companyQueries[0]!.sql, /FROM shipments s WHERE s\.company_id=\?/);
  assert.match(companyQueries[0]!.sql, /COUNT\(DISTINCT NULLIF\(TRIM\(customer_id\),''\)\) AS customersServed/);
  assert.match(companyQueries[0]!.sql, /SUM\(current_event='DELIVERED'\)/);
  assert.match(companyQueries[3]!.sql, /GROUP BY/);
  assert.match(companyQueries[4]!.sql, /GROUP BY COALESCE/);
  assert.match(companyQueries[5]!.sql, /JOIN hubs h ON h\.company_id=s\.company_id/);
  assert.match(companyQueries[6]!.sql, /DATE_SUB\(CURRENT_DATE\(\),INTERVAL 11 MONTH\)/);
  assert.ok(calls.slice(7).every((call) => JSON.stringify(call.values).includes("CUS-7")));
  assert.match(calls[7]!.sql, /company_id=\? AND s\.customer_id=\?/);
  assert.match(companyQueries[3]!.sql, /ORDER BY shipments DESC/);
});

test("empty company network and customer history return honest empty aggregates", async () => {
  const { executor } = mockExecutor([
    [{ total: 0, delivered: 0, active: 0, customersServed: 0 }],
    [{ total: 0 }], [{ total: 0 }], [], [], [], [],
    [{ total: 0, delivered: 0, active: 0, exceptions: 0, awaitingEvent: 0 }],
    [{ total: 0 }], [], [], [{ total: 0 }], [],
  ]);
  const result = await getCustomerDashboardSummary(executor, 91, "CUS-EMPTY");
  assert.deepEqual(result.companyNetwork, {
    totalShipments: 0, deliveredShipments: 0, activeShipments: 0, customersServed: 0,
    statesCovered: 0, hubsCovered: 0, monthlyShipmentActivity: [], destinationSummary: [], routeSummary: [],
  });
  assert.equal(result.personal.totalShipments, 0);
  assert.equal(result.personal.statesCovered, 0);
  assert.deepEqual(result.personal.topRoutes, []);
  assert.deepEqual(result.personal.monthlyActivity, []);
  assert.deepEqual(result.recentShipments, []);
});

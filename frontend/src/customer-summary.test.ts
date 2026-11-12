import assert from "node:assert/strict";
import test from "node:test";
import { emptyCustomerDashboardSummary, normalizeCustomerDashboardSummary } from "./customer-summary";

test("customer summary normalization keeps empty or stale responses renderable", () => {
  assert.deepEqual(normalizeCustomerDashboardSummary(null), emptyCustomerDashboardSummary());
  assert.deepEqual(normalizeCustomerDashboardSummary({ companyNetwork: null, personal: null }), emptyCustomerDashboardSummary());
});

test("customer summary normalization preserves company-scoped aggregates and accepts the previous route field", () => {
  const summary = normalizeCustomerDashboardSummary({
    companyNetwork: {
      totalShipments: "49", deliveredShipments: 20, activeShipments: 4, customersServed: 30,
      routes: [{ origin: "Telangana", destination: "Maharashtra", shipments: "12", delivered: "9", active: "2" }],
      monthlyShipmentActivity: [{ month: "2026-10", shipments: 7 }, null],
      destinationSummary: [{ destination: "Maharashtra", shipments: 12, delivered: 9, active: 2, hubs: [{ hubId: "H2", city: "Mumbai", shipments: 8 }] }],
    },
    personal: { totalShipments: 2, pendingApproval: 1 },
    recentShipments: [{ consignmentNo: "SYN-1" }],
  });

  assert.equal(summary.companyNetwork.totalShipments, 49);
  assert.deepEqual(summary.companyNetwork.routeSummary, [{ origin: "Telangana", destination: "Maharashtra", shipments: 12, delivered: 9, active: 2 }]);
  assert.deepEqual(summary.companyNetwork.monthlyShipmentActivity, [{ month: "2026-10", shipments: 7 }]);
  assert.deepEqual(summary.companyNetwork.destinationSummary[0]?.hubs, [{ hubId: "H2", city: "Mumbai", shipments: 8 }]);
  assert.equal(summary.personal.totalShipments, 2);
  assert.equal(summary.personal.pendingApproval, 1);
  assert.deepEqual(summary.recentShipments, [{ consignmentNo: "SYN-1" }]);
});

test("invalid optional analytics values become empty values instead of throwing during render", () => {
  const summary = normalizeCustomerDashboardSummary({
    companyNetwork: { totalShipments: "NaN", routeSummary: [null, {}, { origin: "Only origin" }], destinationSummary: "bad", monthlyShipmentActivity: [{}] },
    recentShipments: "bad",
  });
  assert.equal(summary.companyNetwork.totalShipments, 0);
  assert.deepEqual(summary.companyNetwork.routeSummary, []);
  assert.deepEqual(summary.companyNetwork.destinationSummary, []);
  assert.deepEqual(summary.companyNetwork.monthlyShipmentActivity, []);
  assert.deepEqual(summary.recentShipments, []);
});

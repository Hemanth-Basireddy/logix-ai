import assert from "node:assert/strict";
import test from "node:test";
import type { FieldPacket, QueryResult } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import {
  createLogisticsTask,
  getExecutiveTaskDetail,
  listExecutiveTasks,
  listExecutiveAssignmentHistory,
  getExecutiveAssignmentHistoryDetail,
  listHubManagerTasks,
  LogisticsTaskError,
  parseTaskAction,
  performExecutiveTaskAction,
  recordExecutiveCollection,
} from "./logistics-executive-data.js";

function mockConnection(results: unknown[]) {
  const calls: Array<{ sql: string; values: unknown }> = [];
  const connection = {
    execute: async <T extends QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]> => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      return [results.shift() as T, []];
    },
  } as unknown as PoolConnection;
  return { connection, calls };
}

const shipment = (overrides: Record<string, unknown> = {}) => [{
  consignmentNo: "TRACK-1", originHubId: "HUB-1", destinationHubId: "HUB-2", routeId: "R1",
  deliveryStatus: "", shipmentStatus: "In Transit", shipmentMatches: 1,
  origin1: "EXEC-1", origin2: null, destination1: "EXEC-2", destination2: null, hubId: "HUB-1",
  ...overrides,
}];

test("executive task reads use the existing shipment assignment fields and stay company and employee scoped", async () => {
  const { connection, calls } = mockConnection([[], []]);
  await listExecutiveTasks(connection, 1, "EXEC-1", { status: "PENDING", type: "PICKUP", search: "TRACK" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /s\.company_id = \?/);
  assert.match(calls[0]!.sql, /s\.receiver_pincode AS recipientPincode/);
  assert.doesNotMatch(calls[0]!.sql, /s\.recipient_pincode/);
  assert.match(calls[0]!.sql, /origin_logistics_executive_1_id = \? OR s\.origin_logistics_executive_2_id = \?/);
  assert.match(calls[0]!.sql, /LEFT JOIN logistics_task_progress/);
  assert.match(calls[0]!.sql, /eh\.employee_id=\?/);
  assert.deepEqual(calls[0]!.values, [1, "EXEC-1", "EXEC-1", "EXEC-1", "PENDING", "%TRACK%", "%TRACK%", "%TRACK%"]);
});

test("dataset assignment history is separated from operational progress and uses both assigned executive slots", async () => {
  const syntheticRecord = { taskType: "PICKUP", recordedOutcome: "On Time", eventCount: 0, pickedUpAt: null, handedOverAt: null };
  const { connection, calls } = mockConnection([[{ total: 1 }], [syntheticRecord]]);
  const result = await listExecutiveAssignmentHistory(connection, 1, "EXEC-1", { type: "PICKUP", limit: 20, offset: 0 });
  assert.equal(result.total, 1);
  assert.equal((result.assignments[0] as unknown as typeof syntheticRecord).recordedOutcome, "On Time");
  assert.match(calls[0]!.sql, /s\.origin_logistics_executive_1_id = \? OR s\.origin_logistics_executive_2_id = \?/);
  assert.match(calls[0]!.sql, /s\.company_id = \?/);
  assert.match(calls[0]!.sql, /NOT EXISTS \(SELECT 1 FROM logistics_task_progress/);
  assert.match(calls[0]!.sql, /'on time','delayed'/);
  assert.match(calls[1]!.sql, /history_events\.pickedUpAt/);
  assert.match(calls[1]!.sql, /history_events\.handedOverAt/);
  assert.doesNotMatch(calls[1]!.sql, /AS status/);
  assert.deepEqual(calls[0]!.values, [1, "EXEC-1", "EXEC-1", "PICKUP"]);
});

test("dataset assignment detail returns only persisted events for the authenticated company and executive", async () => {
  const { connection, calls } = mockConnection([[{ consignmentNo: "TRACK-1", recordedOutcome: "Delayed" }], [
    { eventType: "PICKUP_EXCEPTION", eventTime: "2025-01-02 08:00:00", notes: "Address unavailable" },
    { eventType: "PICKED_UP", eventTime: "2025-01-02 11:00:00", notes: null },
  ]]);
  const detail = await getExecutiveAssignmentHistoryDetail(connection, 1, "EXEC-1", "PICKUP", "TRACK-1");
  assert.equal((detail as unknown as { recordedOutcome?: string } | null)?.recordedOutcome, "Delayed");
  assert.equal((detail as unknown as { eventCount?: number } | null)?.eventCount, 2);
  assert.equal((detail as unknown as { failedAttemptCount?: number } | null)?.failedAttemptCount, 1);
  assert.equal((detail as unknown as { pickedUpAt?: string | null } | null)?.pickedUpAt, "2025-01-02 11:00:00");
  assert.equal((detail as unknown as { deliveredAt?: string | null } | null)?.deliveredAt, null);
  assert.match(calls[0]!.sql, /s\.company_id = \?/);
  assert.match(calls[0]!.sql, /origin_logistics_executive_1_id = \? OR s\.origin_logistics_executive_2_id = \?/);
  assert.match(calls[1]!.sql, /shipment_events/);
  assert.deepEqual(calls[1]!.values, [1, "TRACK-1"]);

  const unauthorized = mockConnection([[]]);
  assert.equal(await getExecutiveAssignmentHistoryDetail(unauthorized.connection, 2, "OTHER-EXEC", "PICKUP", "TRACK-1"), null);
  assert.equal(unauthorized.calls.length, 1);
});

test("executive task detail refuses a shipment assigned to another employee", async () => {
  const { connection, calls } = mockConnection([[]]);
  assert.equal(await getExecutiveTaskDetail(connection, 1, "EXEC-1", "PICKUP", "TRACK-1"), null);
  assert.match(calls[0]!.sql, /s\.company_id = \? AND s\.consignment_no = \?/);
  assert.match(calls[0]!.sql, /origin_logistics_executive_1_id = \?/);
  assert.equal(calls.length, 1);
});

test("task details include the assigned hub city for pickup and delivery", async () => {
  const pickup = mockConnection([shipment({ hubCity: "Origin City" }), [{ assigned: 1 }], [], []]);
  const pickupDetail = await getExecutiveTaskDetail(pickup.connection, 1, "EXEC-1", "PICKUP", "TRACK-1");
  assert.equal((pickupDetail as unknown as { hubCity?: string } | null)?.hubCity, "Origin City");
  assert.match(pickup.calls[0]!.sql, /oh\.city AS hubCity/);

  const delivery = mockConnection([shipment({ hubCity: "Destination City" }), [{ assigned: 1 }], [], []]);
  const deliveryDetail = await getExecutiveTaskDetail(delivery.connection, 1, "EXEC-1", "DELIVERY", "TRACK-1");
  assert.equal((deliveryDetail as unknown as { hubCity?: string } | null)?.hubCity, "Destination City");
  assert.match(delivery.calls[0]!.sql, /dh\.city AS hubCity/);
});

test("Hub Manager task list scopes to assigned hubs and includes both existing executive assignment slots", async () => {
  const { connection, calls } = mockConnection([[]]);
  await listHubManagerTasks(connection, 1, ["HUB-1"], "HUB-1", "PENDING");
  assert.match(calls[0]!.sql, /origin_logistics_executive_1_id OR ex\.employee_id=s\.origin_logistics_executive_2_id/);
  assert.match(calls[0]!.sql, /destination_logistics_executive_1_id OR ex\.employee_id=s\.destination_logistics_executive_2_id/);
  assert.match(calls[0]!.sql, /s\.origin_hub_id IN \(\?\)/);
  assert.deepEqual(calls[0]!.values, [1, "HUB-1", "PENDING", 1, "HUB-1", "PENDING"]);
});

test("Hub Manager assignment writes the existing assignment slot and initializes progress without a duplicate assignee table", async () => {
  const { connection, calls } = mockConnection([
    [{ assigned: 1 }], [{ assigned: 1 }],
    shipment({ eventType: "BOOKED", eventHubId: "HUB-1", origin1: "EXEC-1" }), [{ approved: 1 }], [{ route_id: "R1" }],
    { affectedRows: 1 },
  ]);
  const result = await createLogisticsTask(connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-1", employeeId: "EXEC-1", consignmentNo: "TRACK-1", taskType: "PICKUP",
  });
  assert.deepEqual(result, { taskKey: "PICKUP:TRACK-1", taskType: "PICKUP", consignmentNo: "TRACK-1", status: "PENDING" });
  assert.match(calls[0]!.sql, /e\.company_id=\?/);
  assert.match(calls[1]!.sql, /UPPER\(e\.role\)='LOGISTICS_EXECUTIVE'/);
  assert.match(calls[2]!.sql, /s\.company_id=\? AND s\.consignment_no=\?/);
  assert.match(calls[3]!.sql, /customer_booking_requests.*status='APPROVED'/);
  assert.match(calls[4]!.sql, /FROM routes WHERE route_id=\?/);
  assert.match(calls[5]!.sql, /INSERT INTO logistics_task_progress/);
  assert.equal(calls.length, 6);
});

test("Hub Manager cannot assign a BOOKED shipment without an approved booking request", async () => {
  const { connection, calls } = mockConnection([
    [{ assigned: 1 }], [{ assigned: 1 }], shipment({ eventType: "BOOKED", originHubId: "HUB-1" }), [],
  ]);
  await assert.rejects(createLogisticsTask(connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-1", employeeId: "EXEC-1", consignmentNo: "TRACK-1", taskType: "PICKUP",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 409);
  assert.equal(calls.length, 4);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO logistics_task_progress")), false);
});

test("destination delivery assignment requires physical receipt, and succeeds after its persisted event", async () => {
  const beforeReceipt = mockConnection([
    [{ assigned: 1 }], [{ assigned: 1 }],
    shipment({ eventType: "ARRIVED_AT_DESTINATION_HUB", eventHubId: "HUB-2" }),
    [{ approved: 1 }], [{ route_id: "R1" }],
  ]);
  await assert.rejects(createLogisticsTask(beforeReceipt.connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-2", employeeId: "EXEC-3", consignmentNo: "TRACK-1", taskType: "DELIVERY",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 409);
  assert.equal(beforeReceipt.calls.some((call) => call.sql.includes("INSERT INTO logistics_task_progress")), false);

  const received = mockConnection([
    [{ assigned: 1 }], [{ assigned: 1 }],
    shipment({ eventType: "RECEIVED_AT_DESTINATION_HUB", eventHubId: "HUB-2" }),
    [{ approved: 1 }], [{ route_id: "R1" }],
    { affectedRows: 1 }, { affectedRows: 1 },
  ]);
  const result = await createLogisticsTask(received.connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-2", employeeId: "EXEC-3", consignmentNo: "TRACK-1", taskType: "DELIVERY",
  });
  assert.equal(result.taskType, "DELIVERY");
  assert.deepEqual(received.calls[5]!.values, ["EXEC-3", 1, "TRACK-1"]);
  assert.match(received.calls[6]!.sql, /INSERT INTO logistics_task_progress/);
});

test("task assignment rejects wrong hub, full foreign assignee slots, and recorded historical outcome", async () => {
  const wrongHub = mockConnection([[]]);
  await assert.rejects(createLogisticsTask(wrongHub.connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-X", employeeId: "EXEC-1", consignmentNo: "TRACK-1", taskType: "PICKUP",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 403);

  const full = mockConnection([
    [{ assigned: 1 }], [{ assigned: 1 }],
    shipment({ eventType: "BOOKED", origin1: "EXEC-2", origin2: "EXEC-3" }), [{ approved: 1 }], [{ route_id: "R1" }],
  ]);
  await assert.rejects(createLogisticsTask(full.connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-1", employeeId: "EXEC-1", consignmentNo: "TRACK-1", taskType: "PICKUP",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 409);

  const finalOutcome = mockConnection([
    [{ assigned: 1 }], [{ assigned: 1 }], shipment({ deliveryStatus: "delayed", eventType: "BOOKED" }), [{ approved: 1 }],
  ]);
  await assert.rejects(createLogisticsTask(finalOutcome.connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-1", employeeId: "EXEC-1", consignmentNo: "TRACK-1", taskType: "PICKUP",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 409);
});

test("task assignment and actions reject shipments outside the authenticated company", async () => {
  const assignment = mockConnection([[{ assigned: 1 }], [{ assigned: 1 }], []]);
  await assert.rejects(createLogisticsTask(assignment.connection, {
    companyId: 1, managerId: "MGR-1", hubId: "HUB-1", employeeId: "EXEC-1", consignmentNo: "TRACK-1", taskType: "PICKUP",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 404);
  assert.equal(assignment.calls.length, 3);
  assert.match(assignment.calls[2]!.sql, /s\.company_id=\? AND s\.consignment_no=\?/);

  const action = mockConnection([[]]);
  await assert.rejects(performExecutiveTaskAction(action.connection, {
    companyId: 2, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "accept",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 404);
  assert.match(action.calls[0]!.sql, /s\.company_id=\?/);
});

function actionFixture(taskType: "PICKUP" | "DELIVERY", status: string, eventType: string | null, overrides: Record<string, unknown> = {}) {
  const event = eventType ? [{ eventType, hubId: taskType === "DELIVERY" ? "HUB-2" : eventType === "PICKED_UP" ? null : "HUB-1" }] : [];
  return mockConnection([
    shipment({
      hubId: taskType === "PICKUP" ? "HUB-1" : "HUB-2",
      [taskType === "PICKUP" ? "originHubId" : "destinationHubId"]: taskType === "PICKUP" ? "HUB-1" : "HUB-2",
      [taskType === "PICKUP" ? "origin1" : "destination1"]: "EXEC-1",
      ...overrides,
    }),
    [{ assigned: 1 }], status ? [{ status, failureReason: null }] : [], event, [],
  ]);
}

test("task acceptance is available only to the assigned active hub executive", async () => {
  const { connection, calls } = actionFixture("PICKUP", "", "BOOKED");
  const result = await performExecutiveTaskAction(connection, { companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "accept" });
  assert.equal(result.status, "ACCEPTED");
  assert.match(calls[0]!.sql, /origin_logistics_executive_1_id=\?/);
  assert.match(calls[1]!.sql, /employee_hubs/);
  assert.match(calls[4]!.sql, /INSERT INTO logistics_task_progress/);
});

test("wrong tracking ID and duplicate pickup do not append events", async () => {
  const wrongTracking = actionFixture("PICKUP", "IN_PROGRESS", "BOOKED");
  await assert.rejects(performExecutiveTaskAction(wrongTracking.connection, {
    companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "pickup", trackingId: "WRONG",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 400);
  assert.equal(wrongTracking.calls.length, 4);

  const duplicate = actionFixture("PICKUP", "IN_PROGRESS", "PICKED_UP");
  await assert.rejects(performExecutiveTaskAction(duplicate.connection, {
    companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "pickup", trackingId: "TRACK-1",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 409);
  assert.equal(duplicate.calls.length, 4);
});

test("revoked hub assignment is rejected before any task state or shipment event is changed", async () => {
  const revoked = mockConnection([shipment(), []]);
  await assert.rejects(performExecutiveTaskAction(revoked.connection, {
    companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "accept",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 403);
  assert.equal(revoked.calls.length, 2);
});

test("pickup handover requires pickup and records a distinct handover event for manager receipt", async () => {
  const { connection, calls } = actionFixture("PICKUP", "IN_PROGRESS", "PICKED_UP");
  calls.length = 0;
  const result = await performExecutiveTaskAction(connection, { companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "handover" });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls[4]!.values, ["TRACK-1", "HANDED_OVER_AT_ORIGIN_HUB", "COMPLETED", "HUB-1", "EXEC-1", null]);
  assert.match(calls[5]!.sql, /ON DUPLICATE KEY UPDATE status=VALUES\(status\)/);
});

test("delivery completion requires out-for-delivery and preserves the shipment outcome column", async () => {
  const { connection, calls } = actionFixture("DELIVERY", "IN_PROGRESS", "OUT_FOR_DELIVERY");
  const result = await performExecutiveTaskAction(connection, { companyId: 1, employeeId: "EXEC-1", taskType: "DELIVERY", consignmentNo: "TRACK-1", action: "deliver", trackingId: "TRACK-1" });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls[5]!.values, ["TRACK-1", "DELIVERED", "COMPLETED", "HUB-2", "EXEC-1", null]);
  assert.match(calls[6]!.sql, /logistics_task_progress/);
  assert.doesNotMatch(calls[6]!.sql, /UPDATE shipments/);
});

test("disposable workflow fixture completes pickup handover and destination delivery in order", async () => {
  const steps: Array<{
    taskType: "PICKUP" | "DELIVERY";
    action: "accept" | "start" | "pickup" | "handover" | "out-for-delivery" | "deliver";
    status: string;
    event: string;
    expectedStatus: string;
    trackingId?: string;
  }> = [
    { taskType: "PICKUP", action: "accept", status: "", event: "BOOKED", expectedStatus: "ACCEPTED" },
    { taskType: "PICKUP", action: "start", status: "ACCEPTED", event: "BOOKED", expectedStatus: "IN_PROGRESS" },
    { taskType: "PICKUP", action: "pickup", status: "IN_PROGRESS", event: "BOOKED", expectedStatus: "IN_PROGRESS", trackingId: "TRACK-1" },
    { taskType: "PICKUP", action: "handover", status: "IN_PROGRESS", event: "PICKED_UP", expectedStatus: "COMPLETED" },
    { taskType: "DELIVERY", action: "accept", status: "", event: "RECEIVED_AT_DESTINATION_HUB", expectedStatus: "ACCEPTED" },
    { taskType: "DELIVERY", action: "start", status: "ACCEPTED", event: "RECEIVED_AT_DESTINATION_HUB", expectedStatus: "IN_PROGRESS" },
    { taskType: "DELIVERY", action: "out-for-delivery", status: "IN_PROGRESS", event: "RECEIVED_AT_DESTINATION_HUB", expectedStatus: "IN_PROGRESS", trackingId: "TRACK-1" },
    { taskType: "DELIVERY", action: "deliver", status: "IN_PROGRESS", event: "OUT_FOR_DELIVERY", expectedStatus: "COMPLETED", trackingId: "TRACK-1" },
  ];

  for (const step of steps) {
    const { connection } = actionFixture(step.taskType, step.status, step.event);
    const result = await performExecutiveTaskAction(connection, {
      companyId: 1,
      employeeId: "EXEC-1",
      taskType: step.taskType,
      consignmentNo: "TRACK-1",
      action: step.action,
      ...(step.trackingId ? { trackingId: step.trackingId } : {}),
    });
    assert.equal(result.status, step.expectedStatus, `${step.taskType} ${step.action}`);
  }
});

test("failed attempts need a reason and publish a hub exception event", async () => {
  const invalid = actionFixture("PICKUP", "IN_PROGRESS", "BOOKED");
  await assert.rejects(performExecutiveTaskAction(invalid.connection, {
    companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "fail", reason: "No",
  }), (error: unknown) => error instanceof LogisticsTaskError && error.statusCode === 400);
  assert.equal(invalid.calls.length, 4);

  const valid = actionFixture("PICKUP", "IN_PROGRESS", "BOOKED");
  const result = await performExecutiveTaskAction(valid.connection, {
    companyId: 1, employeeId: "EXEC-1", taskType: "PICKUP", consignmentNo: "TRACK-1", action: "fail", reason: "Customer not available",
  });
  assert.equal(result.status, "FAILED");
  assert.deepEqual(valid.calls[4]!.values, ["TRACK-1", "PICKUP_EXCEPTION", "FAILED", "HUB-1", "EXEC-1", "Customer not available"]);
});

test("assigned Pickup Executive records a demo shipping collection exactly once", async () => {
  const { connection, calls } = mockConnection([
    [{ originHubId:"HUB-1",destinationHubId:"HUB-2",codAmount:null,bookingRequestId:7,collectionMethod:"PAY_AT_PICKUP",paymentStatus:"COLLECTION_DUE",shippingAmount:"180.00",codEnabled:0 }],
    [{ allowed:1 }], [], [{ status:"IN_PROGRESS" }], [{ eventType:"BOOKED",hubId:null }], [], {}, {}, {},
  ]);
  const result=await recordExecutiveCollection(connection,{companyId:1,employeeId:"EXEC-1",taskType:"PICKUP",consignmentNo:"TRACK-1",kind:"SHIPPING",channel:"DEMO_CASH",idempotencyKey:"30a6953c-2798-49de-96a9-9cf742469ee3"});
  assert.deepEqual(result,{consignmentNo:"TRACK-1",kind:"SHIPPING",amount:180,currency:"INR",collectionMethod:"PAY_AT_PICKUP",collectionChannel:"DEMO_CASH",status:"COLLECTED",demo:true});
  assert.ok(calls.some(call=>call.sql.includes("INSERT INTO shipment_collections")));
  assert.ok(calls.some(call=>call.sql.includes("UPDATE shipment_payments SET payment_status='COLLECTED'")));
  assert.equal(calls.some(call=>call.sql.includes("INSERT INTO shipment_events")),false);
});

test("collection idempotency returns an earlier same-company record without inserting twice", async () => {
  const { connection, calls } = mockConnection([
    [{ originHubId:"HUB-1",destinationHubId:"HUB-2",bookingRequestId:7,collectionMethod:"PAY_AT_PICKUP",paymentStatus:"COLLECTION_DUE",shippingAmount:"180.00"}],
    [{ allowed:1 }], [{ collectionId:9,consignmentNo:"TRACK-1",amount:"180.00",collectionMethod:"PAY_AT_PICKUP",collectionChannel:"DEMO_CASH",recordedAt:"2026-01-01 10:00:00" }],
  ]);
  const result=await recordExecutiveCollection(connection,{companyId:1,employeeId:"EXEC-1",taskType:"PICKUP",consignmentNo:"TRACK-1",kind:"SHIPPING",channel:"DEMO_CASH",idempotencyKey:"30a6953c-2798-49de-96a9-9cf742469ee3"});
  assert.equal((result as {duplicate?:boolean}).duplicate,true);
  assert.equal(calls.some(call=>call.sql.includes("INSERT INTO shipment_collections")),false);
});

test("another Executive cannot record collection for an unassigned shipment", async () => {
  const { connection, calls } = mockConnection([[]]);
  await assert.rejects(recordExecutiveCollection(connection,{companyId:1,employeeId:"EXEC-OTHER",taskType:"PICKUP",consignmentNo:"TRACK-1",kind:"SHIPPING",channel:"DEMO_UPI",idempotencyKey:"30a6953c-2798-49de-96a9-9cf742469ee3"}), (error:unknown)=>error instanceof LogisticsTaskError&&error.statusCode===404);
  assert.equal(calls.length,1);
});

test("unknown actions and task types are rejected", () => {
  assert.equal(parseTaskAction("accept"), "accept");
  assert.equal(parseTaskAction("delete"), null);
});

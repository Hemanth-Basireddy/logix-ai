import assert from "node:assert/strict";
import test from "node:test";
import {
  publishAfterCommit,
  publishCompanyDataChanged,
  subscribeToCompanyData,
} from "./company-events.js";

test("company update subscribers receive only their company's events", () => {
  const companyA = 91001;
  const companyB = 91002;
  const receivedA: number[] = [];
  const receivedB: number[] = [];
  const subscriptionA = subscribeToCompanyData(companyA, undefined, (event) => {
    receivedA.push(event.companyId);
  });
  const subscriptionB = subscribeToCompanyData(companyB, undefined, (event) => {
    receivedB.push(event.companyId);
  });

  publishCompanyDataChanged(companyA, "shipment.changed");
  publishCompanyDataChanged(companyB, "hub-assignment.changed");

  assert.deepEqual(receivedA, [companyA]);
  assert.deepEqual(receivedB, [companyB]);
  subscriptionA.unsubscribe();
  subscriptionB.unsubscribe();
});

test("company update subscribers can replay missed events after reconnect", () => {
  const companyId = 91003;
  const first = publishCompanyDataChanged(companyId, "shipment.changed");
  const second = publishCompanyDataChanged(companyId, "exception.changed");
  const subscription = subscribeToCompanyData(companyId, String(first.id), () => {});

  assert.equal(subscription.recoveryRequired, false);
  assert.deepEqual(subscription.replay.map((event) => event.id), [second.id]);
  subscription.unsubscribe();
});

test("hub-scoped subscribers receive updates only for assigned hubs", () => {
  const companyId = 91006;
  const received: string[] = [];
  const subscription = subscribeToCompanyData(
    companyId,
    undefined,
    (event) => received.push(event.hubId ?? "generic"),
    ["HUB-1"],
  );
  publishCompanyDataChanged(companyId, "shipment.changed", "HUB-2");
  publishCompanyDataChanged(companyId, "shipment.changed", "HUB-1");
  assert.deepEqual(received, ["HUB-1"]);
  subscription.unsubscribe();
});

test("customer tracking subscribers receive only their own shipment invalidations", () => {
  const companyId = 91008;
  const received: string[] = [];
  const customerA = subscribeToCompanyData(companyId, undefined, (event) => received.push(event.customerId ?? "unscoped"), undefined, "CUS-A");
  const customerB = subscribeToCompanyData(companyId, undefined, (event) => received.push(event.customerId ?? "unscoped"), undefined, "CUS-B");
  publishCompanyDataChanged(companyId, "shipment.changed", "HUB-1", "CUS-A");
  publishCompanyDataChanged(companyId, "shipment.changed", "HUB-1", "CUS-B");
  publishCompanyDataChanged(companyId, "shipment.changed", "HUB-1");
  assert.deepEqual(received, ["CUS-A", "CUS-B"]);
  customerA.unsubscribe();
  customerB.unsubscribe();
});

test("customer tracking replay stays restricted to the authenticated customer", () => {
  const companyId = 91009;
  const first = publishCompanyDataChanged(companyId, "shipment.changed", undefined, "CUS-A");
  publishCompanyDataChanged(companyId, "shipment.changed", undefined, "CUS-B");
  const subscription = subscribeToCompanyData(companyId, String(first.id - 1), () => {}, undefined, "CUS-A");
  assert.deepEqual(subscription.replay.map((event) => event.customerId), ["CUS-A"]);
  subscription.unsubscribe();
});

test("invalid or future event cursors require client recovery", () => {
  const subscription = subscribeToCompanyData(91004, "not-an-event-id", () => {});
  assert.equal(subscription.recoveryRequired, true);
  assert.deepEqual(subscription.replay, []);
  subscription.unsubscribe();
});

test("transaction update event publishes only after commit succeeds", async () => {
  const companyId = 91005;
  const observed: string[] = [];
  const subscription = subscribeToCompanyData(companyId, undefined, () => {
    observed.push("event");
  });

  test("hub action invalidation is scoped and published only after its commit", async () => {
    const companyId = 91007;
    const received: string[] = [];
    const assignedHub = subscribeToCompanyData(companyId, undefined, () => {
      received.push("assigned");
    }, ["HUB-1"]);
    const otherHub = subscribeToCompanyData(companyId, undefined, () => {
      received.push("other");
    }, ["HUB-2"]);
    const result = await publishAfterCommit(
      async () => { received.push("commit"); },
      companyId,
      "shipment.changed",
      "committed",
      "HUB-1",
    );
    assert.equal(result, "committed");
    assert.deepEqual(received, ["commit", "assigned"]);
    assignedHub.unsubscribe();
    otherHub.unsubscribe();
  });
  await assert.rejects(
    publishAfterCommit(async () => {
      observed.push("failed-commit");
      throw new Error("commit failed");
    }, companyId, "shipment.changed", null),
  );
  assert.deepEqual(observed, ["failed-commit"]);

  const result = await publishAfterCommit(async () => {
    observed.push("committed");
  }, companyId, "shipment.changed", "ok");
  assert.equal(result, "ok");
  assert.deepEqual(observed, ["failed-commit", "committed", "event"]);
  subscription.unsubscribe();
});

test("customer shipment invalidation is emitted only after commit and stays owner scoped", async () => {
  const companyId = 91010;
  const events: string[] = [];
  const owner = subscribeToCompanyData(companyId, undefined, () => events.push("owner"), undefined, "CUS-OWNER");
  const other = subscribeToCompanyData(companyId, undefined, () => events.push("other"), undefined, "CUS-OTHER");
  await publishAfterCommit(async () => { events.push("commit"); }, companyId, "shipment.changed", null, "HUB-1", "CUS-OWNER");
  assert.deepEqual(events, ["commit", "owner"]);
  owner.unsubscribe();
  other.unsubscribe();
});

import assert from "node:assert/strict";
import test from "node:test";
import { destinationForRole, requestedPathForRole } from "./role-routing.js";

test("each authenticated role has its own workspace destination", () => {
  assert.equal(destinationForRole("COMPANY_ADMIN"), "/company-admin");
  assert.equal(destinationForRole("OPERATIONS_MANAGER"), "/operations");
  assert.equal(destinationForRole("HUB_MANAGER"), "/hub-manager");
  assert.equal(destinationForRole("LOGISTICS_EXECUTIVE"), "/logistics-executive");
});

test("requested workspace paths are preserved only for the authenticated role", () => {
  assert.equal(requestedPathForRole("COMPANY_ADMIN", "/company-admin/employees"), "/company-admin/employees");
  assert.equal(requestedPathForRole("OPERATIONS_MANAGER", "/operations"), "/operations");
  assert.equal(requestedPathForRole("HUB_MANAGER", "/hub-manager"), "/hub-manager");
  assert.equal(requestedPathForRole("HUB_MANAGER", "/operations"), null);
  assert.equal(requestedPathForRole("LOGISTICS_EXECUTIVE", "/hub-manager"), null);
  assert.equal(requestedPathForRole("OPERATIONS_MANAGER", "//example.com"), null);
  assert.equal(requestedPathForRole("OPERATIONS_MANAGER", "https://example.com"), null);
});

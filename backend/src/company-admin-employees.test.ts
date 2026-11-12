import assert from "node:assert/strict";
import test from "node:test";
import argon2 from "argon2";
import type { FieldPacket, QueryResult } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import {
  createCompanyEmployee,
  EmployeeManagementError,
  updateCompanyEmployee,
} from "./company-admin-employees.js";

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

const employeeInput = {
  name: "Test Employee",
  role: "LOGISTICS_EXECUTIVE" as const,
  email: null,
  phone: null,
  status: "Active" as const,
  hubIds: ["HUB-1"],
};

test("employee creation stores an Argon2id hash and only assigns validated company hubs", async () => {
  const { connection, calls } = mockConnection([
    [{ total: 1 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    [],
    { affectedRows: 1 },
  ]);
  const result = await createCompanyEmployee(
    connection,
    65,
    "EMP-NEW",
    "a-secure-temporary-password",
    employeeInput,
  );

  assert.deepEqual(result, { employeeId: "EMP-NEW" });
  assert.match(calls[0]!.sql, /FROM hubs WHERE company_id = \? AND status = 'Active'/);
  assert.deepEqual(calls[0]!.values, [65, "HUB-1"]);
  assert.match(calls[1]!.sql, /INSERT INTO employees/);
  const employeeValues = calls[1]!.values as unknown[];
  assert.equal(employeeValues[1], 65);
  assert.equal(employeeValues[2], "EMP-NEW");
  assert.equal(employeeValues[4], "LOGISTICS_EXECUTIVE");
  assert.equal(typeof employeeValues[7], "string");
  assert.match(employeeValues[7] as string, /^\$argon2id\$/);
  assert.notEqual(employeeValues[7], "a-secure-temporary-password");
  assert.match(calls[2]!.sql, /UPDATE employee_hubs SET status = 'Inactive'/);
  assert.deepEqual(calls[2]!.values, ["EMP-NEW", 65]);
  assert.match(calls[4]!.sql, /INSERT INTO employee_hubs/);
});

test("admin-created operations managers retain the selected role and all validated hub assignments", async () => {
  const { connection, calls } = mockConnection([
    [{ total: 3 }],
    { affectedRows: 1 },
    { affectedRows: 0 },
    [],
    { affectedRows: 1 },
    [],
    { affectedRows: 1 },
    [],
    { affectedRows: 1 },
  ]);
  await createCompanyEmployee(
    connection,
    65,
    "OPS-NEW",
    "a-secure-temporary-password",
    {
      ...employeeInput,
      role: "OPERATIONS_MANAGER",
      hubIds: ["HUB-1", "HUB-2", "HUB-3"],
    },
  );

  const employeeValues = calls[1]!.values as unknown[];
  assert.equal(employeeValues[4], "OPERATIONS_MANAGER");
  assert.deepEqual(calls[0]!.values, [65, "HUB-1", "HUB-2", "HUB-3"]);
  const assignmentInserts = calls.filter(({ sql }) => sql.includes("INSERT INTO employee_hubs"));
  assert.equal(assignmentInserts.length, 3);
  assert.deepEqual(
    assignmentInserts.map(({ values }) => (values as unknown[]).slice(0, 2)),
    [["OPS-NEW", "HUB-1"], ["OPS-NEW", "HUB-2"], ["OPS-NEW", "HUB-3"]],
  );
});

test("company admins can create a Hub Manager with a hashed initial password and assigned hubs", async () => {
  const { connection, calls } = mockConnection([
    [{ total: 2 }],
    { affectedRows: 1 },
    { affectedRows: 1 },
    [],
    { affectedRows: 1 },
    [],
    { affectedRows: 1 },
  ]);
  await createCompanyEmployee(
    connection,
    65,
    "HUB-MGR-NEW",
    "a-secure-temporary-password",
    {
      ...employeeInput,
      role: "HUB_MANAGER",
      hubIds: ["HUB-1", "HUB-2"],
    },
  );

  const employeeValues = calls[1]!.values as unknown[];
  assert.equal(employeeValues[4], "HUB_MANAGER");
  assert.match(employeeValues[7] as string, /^\$argon2id\$/);
  assert.equal(await argon2.verify(employeeValues[7] as string, "a-secure-temporary-password"), true);
  assert.deepEqual(calls[0]!.values, [65, "HUB-1", "HUB-2"]);
  assert.equal(calls.filter(({ sql }) => sql.includes("INSERT INTO employee_hubs")).length, 2);
});

test("company admins can reset an employee password without exposing the stored hash", async () => {
  const { connection, calls } = mockConnection([
    [{ total: 1 }],
    [{ employee_id: "HUB-MGR-1" }],
    [],
    { affectedRows: 1 },
    { affectedRows: 1 },
    { affectedRows: 1 },
    [],
    { affectedRows: 1 },
  ]);
  await updateCompanyEmployee(
    connection,
    65,
    "ADMIN-1",
    "HUB-MGR-1",
    {
      ...employeeInput,
      role: "HUB_MANAGER",
      hubIds: ["HUB-1"],
    },
    "a-different-temporary-password",
  );

  const passwordUpdate = calls.find(({ sql }) => sql.includes("SET password = ?"));
  assert.ok(passwordUpdate);
  assert.match((passwordUpdate.values as unknown[])[0] as string, /^\$argon2id\$/);
  assert.equal(
    await argon2.verify(
      (passwordUpdate.values as unknown[])[0] as string,
      "a-different-temporary-password",
    ),
    true,
  );
  assert.deepEqual((passwordUpdate.values as unknown[]).slice(1), [65, "HUB-MGR-1"]);
  assert.equal(calls.filter(({ sql }) => sql.includes("SET password = ?")).length, 1);
});

test("employee creation rejects cross-company hubs and missing required hub assignments", async () => {
  const wrongCompany = mockConnection([[{ total: 0 }]]);
  await assert.rejects(
    createCompanyEmployee(wrongCompany.connection, 65, "EMP-NEW", "a-secure-temporary-password", employeeInput),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 400,
  );
  assert.equal(wrongCompany.calls.length, 1);

  const noHub = mockConnection([]);
  await assert.rejects(
    createCompanyEmployee(noHub.connection, 65, "EMP-NEW", "a-secure-temporary-password", {
      ...employeeInput,
      hubIds: [],
    }),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 400,
  );
  assert.equal(noHub.calls.length, 0);

  await assert.rejects(
    createCompanyEmployee(noHub.connection, 65, "HUB-MGR-NEW", "a-secure-temporary-password", {
      ...employeeInput,
      role: "HUB_MANAGER",
      hubIds: [],
    }),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 400,
  );
  assert.equal(noHub.calls.length, 0);
});

test("employee password reset rejects weak passwords before database access", async () => {
  const noCalls = mockConnection([]);
  await assert.rejects(
    updateCompanyEmployee(
      noCalls.connection,
      65,
      "ADMIN-1",
      "HUB-MGR-1",
      { ...employeeInput, role: "HUB_MANAGER" },
      "too-short",
    ),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 400,
  );
  assert.equal(noCalls.calls.length, 0);
});

test("employee update prevents self-deactivation and refuses cross-company employee IDs", async () => {
  const self = mockConnection([]);
  await assert.rejects(
    updateCompanyEmployee(self.connection, 65, "ADMIN-1", "ADMIN-1", {
      ...employeeInput,
      role: "OPERATIONS_MANAGER",
    }),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 409,
  );
  assert.equal(self.calls.length, 0);

  const missing = mockConnection([[]]);
  await assert.rejects(
    updateCompanyEmployee(missing.connection, 65, "ADMIN-1", "EMP-OUTSIDE", {
      ...employeeInput,
      role: "COMPANY_ADMIN",
      hubIds: [],
    }),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 404,
  );
  assert.equal(missing.calls.length, 1);
  assert.match(missing.calls[0]!.sql, /WHERE company_id = \? AND employee_id = \? FOR UPDATE/);
  assert.deepEqual(missing.calls[0]!.values, [65, "EMP-OUTSIDE"]);
});

test("employee update preserves the last active company administrator", async () => {
  const { connection, calls } = mockConnection([
    [{ employee_id: "ADMIN-ONLY" }],
    [{ employee_id: "ADMIN-ONLY" }],
  ]);
  await assert.rejects(
    updateCompanyEmployee(connection, 65, "ANOTHER-ADMIN", "ADMIN-ONLY", {
      ...employeeInput,
      role: "OPERATIONS_MANAGER",
      hubIds: [],
    }),
    (error: unknown) => error instanceof EmployeeManagementError && error.statusCode === 409,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.sql, /UPPER\(role\) IN \('ADMIN', 'COMPANY_ADMIN'\)/);
});

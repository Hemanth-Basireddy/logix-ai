import argon2 from "argon2";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { employeeRoles, type EmployeeRole } from "./employee-roles.js";
import { isValidResetPassword } from "./password-policy.js";

export class EmployeeManagementError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "EmployeeManagementError";
  }
}

type EmployeeLockRow = RowDataPacket & {
  employee_id: string;
};

type HubCountRow = RowDataPacket & {
  total: number;
};

type AssignmentRow = RowDataPacket & {
  employee_hub_id: number;
};

type EmployeeInput = {
  name: string;
  role: EmployeeRole;
  email: string | null;
  phone: string | null;
  status: "Active" | "Inactive";
  hubIds: string[];
};

function databaseRole(role: EmployeeRole): string {
  return role === "COMPANY_ADMIN" ? "ADMIN" : role;
}

async function validateHubs(
  connection: PoolConnection,
  companyId: number,
  role: EmployeeRole,
  hubIds: string[],
  active: boolean,
): Promise<void> {
  if (active && (role === "HUB_MANAGER" || role === "LOGISTICS_EXECUTIVE") && hubIds.length === 0) {
    throw new EmployeeManagementError("This role requires at least one active hub assignment.", 400);
  }
  if (hubIds.length === 0) return;

  const placeholders = hubIds.map(() => "?").join(", ");
  const [rows] = await connection.execute<HubCountRow[]>(
    `SELECT COUNT(*) AS total
       FROM hubs
      WHERE company_id = ? AND status = 'Active' AND hub_id IN (${placeholders})`,
    [companyId, ...hubIds],
  );
  if (Number(rows[0]?.total ?? 0) !== hubIds.length) {
    throw new EmployeeManagementError("Select only active hubs belonging to your company.", 400);
  }
}

async function replaceHubAssignments(
  connection: PoolConnection,
  companyId: number,
  employeeId: string,
  hubIds: string[],
): Promise<void> {
  await connection.execute(
    `UPDATE employee_hubs
        SET status = 'Inactive'
      WHERE employee_id = ? AND status = 'Active'
        AND hub_id IN (SELECT hub_id FROM hubs WHERE company_id = ?)`,
    [employeeId, companyId],
  );

  for (const hubId of hubIds) {
    const [rows] = await connection.execute<AssignmentRow[]>(
      `SELECT employee_hub_id
         FROM employee_hubs
        WHERE employee_id = ? AND hub_id = ?
        ORDER BY employee_hub_id
        LIMIT 1
        FOR UPDATE`,
      [employeeId, hubId],
    );
    if (rows[0]) {
      await connection.execute(
        "UPDATE employee_hubs SET status = 'Active' WHERE employee_hub_id = ?",
        [rows[0].employee_hub_id],
      );
    } else {
      await connection.execute(
        `INSERT INTO employee_hubs (employee_id, hub_id, assigned_date, status)
         VALUES (?, ?, CURRENT_DATE(), 'Active')`,
        [employeeId, hubId],
      );
    }
  }
}

export async function createCompanyEmployee(
  connection: PoolConnection,
  companyId: number,
  employeeId: string,
  password: string,
  input: EmployeeInput,
): Promise<{ employeeId: string }> {
  if (!employeeRoles.includes(input.role)) {
    throw new EmployeeManagementError("Select an established employee role.", 400);
  }
  await validateHubs(connection, companyId, input.role, input.hubIds, input.status === "Active");

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await connection.execute<ResultSetHeader>(
    `INSERT INTO employees
       (employee_id, company_id, user_id, name, role, phone, email, password, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      employeeId,
      companyId,
      employeeId,
      input.name,
      databaseRole(input.role),
      input.phone,
      input.email,
      passwordHash,
      input.status,
    ],
  );
  await replaceHubAssignments(
    connection,
    companyId,
    employeeId,
    input.status === "Active" ? input.hubIds : [],
  );
  return { employeeId };
}

export async function updateCompanyEmployee(
  connection: PoolConnection,
  companyId: number,
  currentEmployeeId: string,
  employeeId: string,
  input: EmployeeInput,
  newPassword?: string,
): Promise<{ employeeId: string }> {
  if (!employeeRoles.includes(input.role)) {
    throw new EmployeeManagementError("Select an established employee role.", 400);
  }
  if (newPassword !== undefined && !isValidResetPassword(newPassword)) {
    throw new EmployeeManagementError("Reset passwords must be between 12 and 1024 characters.", 400);
  }
  if (employeeId === currentEmployeeId && (input.role !== "COMPANY_ADMIN" || input.status !== "Active")) {
    throw new EmployeeManagementError("You cannot change your own role or deactivate your account.", 409);
  }
  await validateHubs(connection, companyId, input.role, input.hubIds, input.status === "Active");

  const [rows] = await connection.execute<EmployeeLockRow[]>(
    `SELECT employee_id FROM employees
      WHERE company_id = ? AND employee_id = ?
      FOR UPDATE`,
    [companyId, employeeId],
  );
  if (rows.length !== 1) {
    throw new EmployeeManagementError("Employee was not found for this company.", 404);
  }

  if (input.role !== "COMPANY_ADMIN" || input.status !== "Active") {
    const [companyAdmins] = await connection.execute<EmployeeLockRow[]>(
      `SELECT employee_id FROM employees
        WHERE company_id = ? AND UPPER(role) IN ('ADMIN', 'COMPANY_ADMIN')
          AND UPPER(status) = 'ACTIVE'
        FOR UPDATE`,
      [companyId],
    );
    if (companyAdmins.some((admin) => admin.employee_id === employeeId) && companyAdmins.length <= 1) {
      throw new EmployeeManagementError("A company must keep at least one active Company Admin.", 409);
    }
  }

  await connection.execute(
    `UPDATE employees
        SET name = ?, role = ?, phone = ?, email = ?, status = ?
      WHERE company_id = ? AND employee_id = ?`,
    [input.name, databaseRole(input.role), input.phone, input.email, input.status, companyId, employeeId],
  );
  if (newPassword !== undefined) {
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const [passwordUpdate] = await connection.execute<ResultSetHeader>(
      `UPDATE employees
          SET password = ?
        WHERE company_id = ? AND employee_id = ?`,
      [passwordHash, companyId, employeeId],
    );
    if (passwordUpdate.affectedRows !== 1) {
      throw new EmployeeManagementError("Employee password could not be reset.", 404);
    }
  }
  await replaceHubAssignments(
    connection,
    companyId,
    employeeId,
    input.status === "Active" ? input.hubIds : [],
  );
  return { employeeId };
}

export function isEmployeeRole(value: string): value is EmployeeRole {
  return employeeRoles.some((role) => role === value);
}

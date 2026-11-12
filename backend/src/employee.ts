import type { RowDataPacket } from "mysql2";
import { brandingForCompany } from "./config.js";
import { pool } from "./db.js";
import { mapEmployeeRole, type EmployeeRole } from "./employee-roles.js";
export { isArgon2idHash, mapEmployeeRole } from "./employee-roles.js";

export type AuthenticatedEmployee = {
  employeeId: string;
  name: string;
  role: EmployeeRole;
  company: {
    id: number;
    name: string;
    branding: ReturnType<typeof brandingForCompany>;
  };
  assignedHubs: Array<{
    id: string;
    city: string;
  }>;
};

type EmployeeRow = RowDataPacket & {
  employee_id: string;
  name: string;
  role: string;
  company_id: number;
  company_name: string;
  company_status: string | null;
  employee_status: string | null;
  password?: string | null;
};

type HubRow = RowDataPacket & {
  hub_id: string;
  city: string;
};

export async function findEmployeeForLogin(employeeId: string): Promise<EmployeeRow | null> {
  const [rows] = await pool.execute<EmployeeRow[]>(
    `SELECT e.employee_id, e.name, e.role, e.company_id, e.password,
            e.status AS employee_status, c.company_name, c.status AS company_status
       FROM employees e
       JOIN companies c ON c.company_id = e.company_id
      WHERE e.employee_id = ?
      LIMIT 1`,
    [employeeId],
  );
  return rows[0] ?? null;
}

export async function loadAuthenticatedEmployee(
  employeeId: string,
): Promise<AuthenticatedEmployee | null> {
  const [rows] = await pool.execute<EmployeeRow[]>(
    `SELECT e.employee_id, e.name, e.role, e.company_id,
            e.status AS employee_status, c.company_name, c.status AS company_status
       FROM employees e
       JOIN companies c ON c.company_id = e.company_id
      WHERE e.employee_id = ?
      LIMIT 1`,
    [employeeId],
  );
  const row = rows[0];
  if (
    !row ||
    row.employee_status?.toUpperCase() !== "ACTIVE" ||
    row.company_status?.toUpperCase() !== "ACTIVE"
  ) {
    return null;
  }

  const role = mapEmployeeRole(row.role);
  if (!role) {
    return null;
  }

  const [hubRows] = await pool.execute<HubRow[]>(
    `SELECT h.hub_id, h.city
       FROM employee_hubs eh
       JOIN hubs h ON h.hub_id = eh.hub_id
      WHERE eh.employee_id = ?
        AND eh.status = 'Active'
        AND h.status = 'Active'
        AND h.company_id = ?
      ORDER BY h.city, h.hub_id`,
    [employeeId, row.company_id],
  );
  const assignedHubs = hubRows.map((hub) => ({ id: hub.hub_id, city: hub.city }));

  return {
    employeeId: row.employee_id,
    name: row.name,
    role,
    company: {
      id: row.company_id,
      name: row.company_name,
      branding: brandingForCompany(row.company_id),
    },
    assignedHubs,
  };
}

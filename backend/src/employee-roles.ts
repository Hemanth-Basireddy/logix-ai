export const employeeRoles = [
  "COMPANY_ADMIN",
  "OPERATIONS_MANAGER",
  "HUB_MANAGER",
  "LOGISTICS_EXECUTIVE",
] as const;

export type EmployeeRole = (typeof employeeRoles)[number];

export function mapEmployeeRole(databaseRole: string): EmployeeRole | null {
  switch (databaseRole.trim().toUpperCase()) {
    case "ADMIN":
    case "COMPANY_ADMIN":
      return "COMPANY_ADMIN";
    case "OPERATIONS_MANAGER":
      return "OPERATIONS_MANAGER";
    case "HUB_MANAGER":
      return "HUB_MANAGER";
    case "LOGISTICS_EXECUTIVE":
      return "LOGISTICS_EXECUTIVE";
    default:
      return null;
  }
}

export function isArgon2idHash(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("$argon2id$");
}

import type { EmployeeRole } from "./types";

export function destinationForRole(role: EmployeeRole): string {
  switch (role) {
    case "COMPANY_ADMIN":
      return "/company-admin";
    case "OPERATIONS_MANAGER":
      return "/operations";
    case "HUB_MANAGER":
      return "/hub-manager";
    case "LOGISTICS_EXECUTIVE":
      return "/logistics-executive";
  }
}

export function requestedPathForRole(role: EmployeeRole, path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  if (role === "COMPANY_ADMIN" && (path === "/company-admin" || path.startsWith("/company-admin/"))) {
    return path;
  }
  if (
    (role === "OPERATIONS_MANAGER" && path === "/operations") ||
    (role === "HUB_MANAGER" && path === "/hub-manager") ||
    (role === "LOGISTICS_EXECUTIVE" && path === "/logistics-executive")
  ) {
    return path;
  }
  return null;
}

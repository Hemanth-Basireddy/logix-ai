import argon2 from "argon2";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import {
  findEmployeeForLogin,
  isArgon2idHash,
  loadAuthenticatedEmployee,
} from "./employee.js";
import type { EmployeeRole } from "./employee-roles.js";

export const authCookieName = "logix_session";
const sessionLifetimeSeconds = 60 * 60 * 8;

export type AuthenticatedEmployee = Exclude<
  Awaited<ReturnType<typeof loadAuthenticatedEmployee>>,
  null
>;

declare global {
  namespace Express {
    interface Request {
      employee?: AuthenticatedEmployee;
    }
  }
}

function setSessionCookie(response: Response, employeeId: string): void {
  const token = jwt.sign({ sub: employeeId }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: sessionLifetimeSeconds,
  });
  response.cookie(authCookieName, token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    path: "/api",
    maxAge: sessionLifetimeSeconds * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(authCookieName, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    path: "/api",
  });
}

export async function login(
  employeeId: string,
  password: string,
  response: Response,
): Promise<Awaited<ReturnType<typeof loadAuthenticatedEmployee>>> {
  const row = await findEmployeeForLogin(employeeId);
  if (
    !row ||
    row.employee_status?.toUpperCase() !== "ACTIVE" ||
    row.company_status?.toUpperCase() !== "ACTIVE" ||
    !isArgon2idHash(row.password)
  ) {
    return null;
  }

  const passwordMatches = await argon2.verify(row.password, password);
  if (!passwordMatches) {
    return null;
  }

  const employee = await loadAuthenticatedEmployee(row.employee_id);
  if (employee) {
    setSessionCookie(response, employee.employeeId);
  }
  return employee;
}

export async function requireEmployee(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = request.cookies?.[authCookieName];
  if (typeof token !== "string") {
    response.status(401).json({ error: "Sign in required." });
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      response.status(401).json({ error: "Sign in required." });
      return;
    }

    const employee = await loadAuthenticatedEmployee(decoded.sub);
    if (!employee) {
      clearSessionCookie(response);
      response.status(401).json({ error: "Sign in required." });
      return;
    }
    request.employee = employee;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      clearSessionCookie(response);
      response.status(401).json({ error: "Sign in required." });
      return;
    }
    next(error);
  }
}

export function requireRole(...allowedRoles: EmployeeRole[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.employee || !allowedRoles.includes(request.employee.role)) {
      response.status(403).json({ error: "You are not authorized to access this workspace." });
      return;
    }
    next();
  };
}

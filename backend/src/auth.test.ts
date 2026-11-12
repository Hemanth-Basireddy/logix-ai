import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import {
  authCookieName,
  requireEmployee,
  requireRole,
} from "./auth.js";
import type { AuthenticatedEmployee } from "./auth.js";
import { config } from "./config.js";

function mockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    clearedCookie: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    clearCookie() {
      this.clearedCookie = true;
      return this;
    },
  };
  return response;
}

test("expired sessions are rejected and the session cookie is cleared", async () => {
  const request = {
    cookies: {
      [authCookieName]: jwt.sign({ sub: "EMP-1" }, config.jwtSecret, { expiresIn: -1 }),
    },
  } as unknown as Request;
  const response = mockResponse();
  let nextCalled = false;

  await requireEmployee(
    request,
    response as unknown as Response,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "Sign in required." });
  assert.equal(response.clearedCookie, true);
  assert.equal(nextCalled, false);
});

test("role guard rejects an employee whose authenticated role is not allowed", () => {
  const request = {
    employee: {
      employeeId: "EMP-1",
      role: "HUB_MANAGER",
      company: { id: 65, name: "Company", branding: {} },
      assignedHubs: [],
    } as unknown as AuthenticatedEmployee,
  } as Request;
  const response = mockResponse();
  let nextCalled = false;

  requireRole("OPERATIONS_MANAGER")(
    request,
    response as unknown as Response,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: "You are not authorized to access this workspace." });
  assert.equal(nextCalled, false);
});

test("role guard permits an authenticated Hub Manager only for Hub Manager APIs", () => {
  const request = {
    employee: {
      employeeId: "HUB-MGR-1",
      role: "HUB_MANAGER",
      company: { id: 65, name: "Company", branding: {} },
      assignedHubs: [{ id: "HUB-1", city: "Hub City" }],
    } as unknown as AuthenticatedEmployee,
  } as Request;
  const response = mockResponse();
  let nextCalled = false;

  requireRole("HUB_MANAGER")(
    request,
    response as unknown as Response,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(nextCalled, true);
});

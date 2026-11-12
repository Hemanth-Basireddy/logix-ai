import "dotenv/config";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler, type NextFunction, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import {
  clearSessionCookie,
  login,
  requireEmployee,
  requireRole,
} from "./auth.js";
import { runCompanyDataTransaction, subscribeToCompanyData } from "./company-events.js";
import {
  createCompanyEmployee,
  EmployeeManagementError,
  updateCompanyEmployee,
} from "./company-admin-employees.js";
import { employeeRoles } from "./employee-roles.js";
import { config } from "./config.js";
import {
  getCompanyAdminDashboard,
  listCompanyShipments,
  searchCompanyRecords,
} from "./company-admin-dashboard.js";
import { listCompanyRecords } from "./company-admin-records.js";
import { HubAccessError, listAssignedHubShipments } from "./role-hub-data.js";
import {
  getHubManagerAssignedHubs,
  getHubManagerShipmentEvents,
  getHubManagerWorkspace,
  HubManagerDataError,
  hubManagerShipmentFiltersSchema,
  listHubManagerShipments,
  recordHubShipmentAction,
} from "./hub-manager-data.js";
import {
  getOperationsAssignedHubs,
  getOperationsShipmentEvents,
  getOperationsWorkspace,
  listOperationsShipments,
} from "./operations-data.js";
import {
  createLogisticsTask,
  getExecutiveTaskDetail,
  listHubManagerTasks,
  listExecutiveTasks,
  listExecutiveAssignmentHistory,
  getExecutiveAssignmentHistoryDetail,
  LogisticsTaskError,
  parseTaskAction,
  parseTaskType,
  performExecutiveTaskAction,
  recordExecutiveCollection,
} from "./logistics-executive-data.js";
import { parseIsoDate } from "./dashboard-domain.js";
import {
  TransportError,
  arriveTransportTrip,
  createTransportTrip,
  dispatchTransportTrip,
  listEligibleTransportShipments,
  listTransportTrips,
  markTransportShipmentLoaded,
  reconcileTransportShipment,
  resolveTransportException,
} from "./transport.js";
import { pool } from "./db.js";
import { isValidResetPassword } from "./password-policy.js";
import {
  clearCustomerCookie,
  customerFromRequest,
  customerLoginSession,
  customerSchemas,
  getCustomerShipment,
  getCustomerShippingLabel,
  listCustomerBookingRequests,
  listCustomerHubs,
  listCustomerShipments,
  loginCustomer,
  bookCustomerShipment,
  completeDemoBookingPayment,
  getCustomerShippingQuote,
  listOperationsBookingRequests,
  getBookingRequestScope,
  approveCustomerBooking,
  rejectCustomerBooking,
  registerCustomer,
  requireCustomer,
  optionalCustomer,
  resolveCustomerCompanyId,
  CustomerPortalError,
} from "./customer-portal.js";
import { getCustomerDashboardSummary } from "./customer-dashboard.js";

const app = express();
type CountRow = RowDataPacket & { total: number };
async function activeCustomerCompanyOrRespond(response: Response, next: NextFunction): Promise<number | null> {
  try {
    const companyId = await resolveCustomerCompanyId();
    if (companyId === null) response.status(503).json({ error: "Customer booking is not configured for an active company." });
    return companyId;
  } catch (error) {
    next(error);
    return null;
  }
}
const loginSchema = z.object({
  employeeId: z.string().trim().min(1).max(30),
  password: z.string().min(1).max(1024),
}).strict();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again later." },
});
const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again later." },
});

app.get("/api/customer/config", async (_request, response, next) => {
  const companyId = await activeCustomerCompanyOrRespond(response, next);
  if (companyId === null) return;
  try { response.json({ ...await listCustomerHubs(companyId), historicalNameLoginEnabled: config.customerPortalMode === "demo" }); } catch (error) { next(error); }
});
app.post("/api/customer/register", customerAuthLimiter, async (request, response, next) => {
  const companyId = await activeCustomerCompanyOrRespond(response, next);
  if (companyId === null) return;
  const parsed = customerSchemas.registerSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Enter valid registration details and matching passwords of at least 12 characters." }); return; }
  try {
    const customer = await registerCustomer(companyId, parsed.data);
    response.status(201).json(customerLoginSession(response, { ...customer, companyId }));
  } catch (error) {
    if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; }
    if ((error as { code?: string })?.code === "ER_DUP_ENTRY") { response.status(409).json({ error: "An account with this email already exists." }); return; }
    next(error);
  }
});
app.post("/api/customer/login", customerAuthLimiter, async (request, response, next) => {
  const companyId = await activeCustomerCompanyOrRespond(response, next);
  if (companyId === null) return;
  const parsed = customerSchemas.credentialsSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Enter a valid phone number or email and password." }); return; }
  try {
    const customer = await loginCustomer(companyId, parsed.data.identifier, parsed.data.password);
    if (!customer) { response.status(401).json({ error: "Invalid phone number/email or password." }); return; }
    response.json(customerLoginSession(response, customer));
  } catch (error) { next(error); }
});
app.post("/api/customer/logout", (_request, response) => { clearCustomerCookie(response); response.status(204).end(); });
app.get("/api/customer/events", requireCustomer, (request, response) => {
  const customer = customerFromRequest(request);
  response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }).flushHeaders();
  const writeEvent = (event: string, data: unknown, id?: number) => {
    if (id !== undefined) response.write(`id: ${id}\n`);
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const subscription = subscribeToCompanyData(
    customer.companyId,
    request.header("Last-Event-ID"),
    (event) => writeEvent("tracking-invalidated", { occurredAt: event.occurredAt }, event.id),
    undefined,
    customer.customerId,
  );
  if (subscription.recoveryRequired) {
    writeEvent("recovery-required", { reason: "event-history-unavailable" });
  } else {
    writeEvent("connected", { companyId: customer.companyId });
    for (const event of subscription.replay) writeEvent("tracking-invalidated", { occurredAt: event.occurredAt }, event.id);
  }
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
  request.on("close", () => { clearInterval(heartbeat); subscription.unsubscribe(); response.end(); });
});
app.get("/api/customer/me", async (request, response, next) => {
  try {
    const customer = await optionalCustomer(request);
    response.json({ customer: customer ? { id: customer.customerId, email: customer.email, name: customer.name } : null });
  } catch (error) { next(error); }
});
app.get("/api/customer/shipments", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  const query = z.object({ q:z.string().trim().max(50).optional().default(""), page:z.coerce.number().int().min(1).max(100000).optional().default(1), pageSize:z.coerce.number().int().min(1).max(50).optional().default(10), status:z.enum(["all","delivered","in_transit","exception"]).optional().default("all"), sort:z.enum(["newest","oldest"]).optional().default("newest") }).safeParse(request.query);
  if (!query.success) { response.status(400).json({ error: "Shipment history filters are invalid." }); return; }
  try { response.json(await listCustomerShipments(customer.companyId, customer.customerId, {search:query.data.q,page:query.data.page,pageSize:query.data.pageSize,status:query.data.status,sort:query.data.sort})); } catch (error) { next(error); }
});
app.get("/api/customer/summary", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  try { response.json({ summary: await getCustomerDashboardSummary(pool, customer.companyId, customer.customerId) }); } catch (error) { next(error); }
});
app.get("/api/customer/booking-requests", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  try { response.json({ bookingRequests: await listCustomerBookingRequests(customer.companyId, customer.customerId) }); }
  catch (error) { next(error); }
});
app.get("/api/customer/shipments/:consignmentNo", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  const consignment = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
  if (!consignment.success) { response.status(400).json({ error: "Tracking number is invalid." }); return; }
  try { response.json({ shipment: await getCustomerShipment(customer.companyId, customer.customerId, consignment.data) }); }
  catch (error) { if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});
app.get("/api/customer/shipments/:consignmentNo/label", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  const consignment = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
  if (!consignment.success) { response.status(400).json({ error: "Tracking number is invalid." }); return; }
  try { response.json({ label: await getCustomerShippingLabel(customer.companyId, customer.customerId, consignment.data) }); }
  catch (error) { if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});
app.post("/api/customer/shipments", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  const parsed = customerSchemas.bookingSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Review the shipment details and correct the invalid fields." }); return; }
  try { response.status(201).json({ bookingRequest: await bookCustomerShipment(customer.companyId, customer.customerId, customer.accountId, parsed.data) }); }
  catch (error) { if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; } if ((error as { code?: string })?.code === "ER_DUP_ENTRY") { response.status(409).json({ error: "This booking request has already been submitted." }); return; } next(error); }
});

app.post("/api/customer/quote", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  const parsed = customerSchemas.quoteRequestSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Enter a valid route, service, weight and complete optional dimensions." }); return; }
  try { response.json({ quote: await getCustomerShippingQuote(pool, customer.companyId, parsed.data) }); }
  catch (error) { if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/customer/booking-requests/:bookingRequestId/demo-payment", requireCustomer, async (request, response, next) => {
  const customer = customerFromRequest(request);
  const bookingRequestId = z.coerce.number().int().positive().safeParse(request.params.bookingRequestId);
  if (!bookingRequestId.success) { response.status(400).json({ error: "Booking reference is invalid." }); return; }
  try {
    const payment = await runCompanyDataTransaction(customer.companyId, "shipment.changed", (connection) => completeDemoBookingPayment(connection, customer.companyId, customer.customerId, customer.accountId, bookingRequestId.data), undefined, customer.customerId);
    response.json({ payment });
  } catch (error) { if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.get("/api/operations/booking-requests", requireEmployee, requireRole("OPERATIONS_MANAGER"), async (request, response, next) => {
  try {
    const employee = request.employee!;
    const hubs = await getOperationsAssignedHubs(pool, employee.company.id, employee.employeeId);
    response.json({ bookingRequests: await listOperationsBookingRequests(pool, employee.company.id, hubs.map((hub) => hub.hubId)) });
  } catch (error) { next(error); }
});
app.post("/api/operations/booking-requests/:bookingRequestId/:action", requireEmployee, requireRole("OPERATIONS_MANAGER"), async (request, response, next) => {
  const bookingRequestId = z.coerce.number().int().positive().safeParse(request.params.bookingRequestId);
  const action = z.enum(["approve", "reject"]).safeParse(request.params.action);
  const body = z.object({ reason: z.string().trim().min(5).max(500).optional() }).strict().safeParse(request.body ?? {});
  if (!bookingRequestId.success || !action.success || !body.success || (action.data === "reject" && !body.data.reason)) { response.status(400).json({ error: "A valid action and rejection reason are required." }); return; }
  try {
    const employee = request.employee!;
    const hubs = await getOperationsAssignedHubs(pool, employee.company.id, employee.employeeId);
    const allowedHubIds = hubs.map((hub) => hub.hubId);
    const scope = await getBookingRequestScope(pool, employee.company.id, bookingRequestId.data);
    if (!scope) { response.status(404).json({ error: "Booking request was not found in your company." }); return; }
    const result = await runCompanyDataTransaction<unknown>(employee.company.id, "shipment.changed", async (connection) => {
      if (action.data === "approve") return approveCustomerBooking(connection, employee.company.id, employee.employeeId, bookingRequestId.data, allowedHubIds);
      return rejectCustomerBooking(connection, employee.company.id, employee.employeeId, bookingRequestId.data, allowedHubIds, body.data.reason!);
    },
      String(scope.originHubId), String(scope.customerId));
    response.json({ result });
  } catch (error) {
    if (error instanceof CustomerPortalError) { response.status(error.statusCode).json({ error: error.message }); return; }
    next(error);
  }
});

app.get("/api/health", async (_request, response, next) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", loginLimiter, async (request, response, next) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a valid Employee ID and password." });
    return;
  }

  try {
    const employee = await login(parsed.data.employeeId, parsed.data.password, response);
    if (!employee) {
      response.status(401).json({ error: "Invalid Employee ID or password." });
      return;
    }
    response.json({ employee });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (_request, response) => {
  clearSessionCookie(response);
  response.status(204).end();
});

app.get(
  "/api/auth/me",
  requireEmployee,
  (request, response) => {
    response.json({ employee: request.employee });
  },
);

for (const roleRoute of [
  { path: "/api/operations/hubs/:hubId/shipments", role: "OPERATIONS_MANAGER" },
  { path: "/api/hub-manager/hubs/:hubId/shipments", role: "HUB_MANAGER" },
  { path: "/api/logistics-executive/hubs/:hubId/shipments", role: "LOGISTICS_EXECUTIVE" },
] as const) {
  app.get(
    roleRoute.path,
    requireEmployee,
    requireRole(roleRoute.role),
    async (request, response, next) => {
      const hubId = z.string().trim().min(1).max(20).safeParse(request.params.hubId);
      if (!hubId.success) {
        response.status(400).json({ error: "Hub identifier is invalid." });
        return;
      }
      try {
        const shipments = await listAssignedHubShipments(
          pool,
          request.employee!.company.id,
          request.employee!.employeeId,
          hubId.data,
        );
        response.json({ hubId: hubId.data, shipments });
      } catch (error) {
        if (error instanceof HubAccessError) {
          response.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    },
  );
}

app.get(
  "/api/hub-manager/workspace",
  requireEmployee,
  requireRole("HUB_MANAGER"),
  async (request, response, next) => {
    try {
      response.json(await getHubManagerWorkspace(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
      ));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/hub-manager/shipments",
  requireEmployee,
  requireRole("HUB_MANAGER"),
  async (request, response, next) => {
    const parsed = hubManagerShipmentFiltersSchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Shipment filters are invalid." });
      return;
    }
    try {
      response.json(await listHubManagerShipments(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
        parsed.data,
      ));
    } catch (error) {
      if (error instanceof HubManagerDataError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

app.get(
  "/api/hub-manager/shipments/:consignmentNo/events",
  requireEmployee,
  requireRole("HUB_MANAGER"),
  async (request, response, next) => {
    const consignmentNo = z.string().trim().min(1).max(64).safeParse(request.params.consignmentNo);
    if (!consignmentNo.success) {
      response.status(400).json({ error: "Shipment identifier is invalid." });
      return;
    }
    try {
      const shipment = await getHubManagerShipmentEvents(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
        consignmentNo.data,
      );
      if (!shipment) {
        response.status(404).json({ error: "Shipment was not found in your assigned-hub scope." });
        return;
      }
      response.json({ shipment });
    } catch (error) {
      next(error);
    }
  },
);

for (const action of ["arrive", "receive", "dispatch"] as const) {
  app.post(
    `/api/hub-manager/hubs/:hubId/shipments/:consignmentNo/${action}`,
    requireEmployee,
    requireRole("HUB_MANAGER"),
    async (request, response, next) => {
      const hubId = z.string().trim().min(1).max(20).safeParse(request.params.hubId);
      const consignmentNo = z.string().trim().min(1).max(64).safeParse(request.params.consignmentNo);
      if (!hubId.success || !consignmentNo.success) {
        response.status(400).json({ error: "Hub or shipment identifier is invalid." });
        return;
      }
      try {
        const result = await runCompanyDataTransaction(
          request.employee!.company.id,
          "shipment.changed",
          (connection) => recordHubShipmentAction(
            connection,
            request.employee!.company.id,
            request.employee!.employeeId,
            hubId.data,
            consignmentNo.data,
            action,
          ),
          hubId.data,
          undefined,
          consignmentNo.data,
        );
        response.json({ action: result });
      } catch (error) {
        if (error instanceof HubManagerDataError) {
          response.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    },
  );
}

app.get(
  "/api/hub-manager/events",
  requireEmployee,
  requireRole("HUB_MANAGER"),
  async (request, response, next) => {
    try {
      const hubs = await getHubManagerAssignedHubs(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
      );
      const hubIds = hubs.map((hub) => hub.hubId);
      response.status(200);
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      const writeEvent = (event: string, data: unknown, id?: number) => {
        if (id !== undefined) response.write(`id: ${id}\n`);
        response.write(`event: ${event}\n`);
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      const subscription = subscribeToCompanyData(
        request.employee!.company.id,
        request.header("Last-Event-ID"),
        (event) => writeEvent("hub-data-changed", {
          type: event.type,
          occurredAt: event.occurredAt,
        }, event.id),
        hubIds,
      );
      if (subscription.recoveryRequired) {
        writeEvent("recovery-required", { reason: "event-history-unavailable" });
      } else {
        writeEvent("connected", { assignedHubCount: hubIds.length });
        for (const event of subscription.replay) {
          writeEvent("hub-data-changed", { type: event.type, occurredAt: event.occurredAt }, event.id);
        }
      }
      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
        response.end();
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/hub-manager/tasks",
  requireEmployee,
  requireRole("HUB_MANAGER"),
  async (request, response, next) => {
    const status = z.enum(["ALL", "PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "FAILED"]).default("ALL").safeParse(request.query.status);
    const hubId = z.string().trim().max(20).default("").safeParse(request.query.hubId);
    if (!status.success || !hubId.success) {
      response.status(400).json({ error: "Task filters are invalid." });
      return;
    }
    try {
      const hubs = await getHubManagerAssignedHubs(pool, request.employee!.company.id, request.employee!.employeeId);
      const permittedHubIds = hubs.map((hub) => hub.hubId);
      if (hubId.data && !permittedHubIds.includes(hubId.data)) {
        response.status(403).json({ error: "You are not authorized to access this hub." });
        return;
      }
      const tasks = await listHubManagerTasks(pool, request.employee!.company.id, permittedHubIds, hubId.data, status.data);
      response.json({ tasks });
    } catch (error) { next(error); }
  },
);

app.get("/api/hub-manager/trips", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  try { response.json(await listTransportTrips(pool, request.employee!.company.id, request.employee!.employeeId)); }
  catch (error) { next(error); }
});

app.get("/api/hub-manager/trips/eligible", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const hubId = z.string().trim().min(1).max(20).safeParse(request.query.hubId);
  if (!hubId.success) { response.status(400).json({ error: "Select an authorized origin hub." }); return; }
  try { response.json({ shipments: await listEligibleTransportShipments(pool, request.employee!.company.id, request.employee!.employeeId, hubId.data) }); }
  catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/hub-manager/trips", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const parsed = z.object({
    originHubId: z.string().trim().min(1).max(20), destinationHubId: z.string().trim().min(1).max(20),
    vehicleNumber: z.string().trim().min(2).max(30), driverName: z.string().trim().min(2).max(255),
    driverPhone: z.string().trim().max(40).optional(), scheduledDeparture: z.string().datetime().optional(),
    remarks: z.string().trim().max(1000).optional(),
    consignmentNos: z.array(z.string().trim().min(1).max(50)).min(1).max(30),
  }).strict().safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: "Trip details and a manifest of 1 to 30 unique shipments are required." }); return; }
  try {
    const result = await runCompanyDataTransaction(request.employee!.company.id, "shipment.changed", (connection) => createTransportTrip(connection, { companyId: request.employee!.company.id, employeeId: request.employee!.employeeId, ...parsed.data }));
    response.status(201).json({ trip: result });
  } catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/hub-manager/trips/:tripId/load", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const tripId = z.coerce.number().int().positive().safeParse(request.params.tripId);
  const body = z.object({ consignmentNo: z.string().trim().min(1).max(50) }).strict().safeParse(request.body);
  if (!tripId.success || !body.success) { response.status(400).json({ error: "Trip or shipment identifier is invalid." }); return; }
  try {
    const result = await runCompanyDataTransaction(request.employee!.company.id, "shipment.changed", (connection) => markTransportShipmentLoaded(connection, { companyId: request.employee!.company.id, employeeId: request.employee!.employeeId, tripId: tripId.data, ...body.data }));
    response.json({ shipment: result });
  } catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/hub-manager/trips/:tripId/dispatch", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const tripId = z.coerce.number().int().positive().safeParse(request.params.tripId);
  if (!tripId.success) { response.status(400).json({ error: "Trip identifier is invalid." }); return; }
  try {
    const result = await runCompanyDataTransaction(request.employee!.company.id, "shipment.changed", (connection) => dispatchTransportTrip(connection, { companyId: request.employee!.company.id, employeeId: request.employee!.employeeId, tripId: tripId.data }));
    response.json({ trip: result });
  } catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/hub-manager/trips/:tripId/arrive", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const tripId = z.coerce.number().int().positive().safeParse(request.params.tripId);
  if (!tripId.success) { response.status(400).json({ error: "Trip identifier is invalid." }); return; }
  try {
    const result = await runCompanyDataTransaction(request.employee!.company.id, "shipment.changed", (connection) => arriveTransportTrip(connection, { companyId: request.employee!.company.id, employeeId: request.employee!.employeeId, tripId: tripId.data }));
    response.json({ trip: result });
  } catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/hub-manager/trips/:tripId/manifest/:consignmentNo/reconcile", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const tripId = z.coerce.number().int().positive().safeParse(request.params.tripId);
  const consignmentNo = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
  const body = z.object({ condition: z.enum(["RECEIVED", "MISSING", "DAMAGED"]), reason: z.string().trim().max(500).optional() }).strict().safeParse(request.body);
  if (!tripId.success || !consignmentNo.success || !body.success) { response.status(400).json({ error: "Trip reconciliation details are invalid." }); return; }
  try {
    const result = await runCompanyDataTransaction(request.employee!.company.id, "shipment.changed", (connection) => reconcileTransportShipment(connection, { companyId: request.employee!.company.id, employeeId: request.employee!.employeeId, tripId: tripId.data, consignmentNo: consignmentNo.data, ...body.data }));
    response.json({ shipment: result });
  } catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post("/api/hub-manager/trips/:tripId/manifest/:consignmentNo/resolve", requireEmployee, requireRole("HUB_MANAGER"), async (request, response, next) => {
  const tripId = z.coerce.number().int().positive().safeParse(request.params.tripId);
  const consignmentNo = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
  const body = z.object({ reason: z.string().trim().min(5).max(500) }).strict().safeParse(request.body);
  if (!tripId.success || !consignmentNo.success || !body.success) { response.status(400).json({ error: "Explain how the transport exception was resolved." }); return; }
  try {
    const result = await runCompanyDataTransaction(request.employee!.company.id, "shipment.changed", (connection) => resolveTransportException(connection, { companyId: request.employee!.company.id, employeeId: request.employee!.employeeId, tripId: tripId.data, consignmentNo: consignmentNo.data, ...body.data }));
    response.json({ shipment: result });
  } catch (error) { if (error instanceof TransportError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});

app.post(
  "/api/hub-manager/tasks",
  requireEmployee,
  requireRole("HUB_MANAGER"),
  async (request, response, next) => {
    const parsed = z.object({
      hubId: z.string().trim().min(1).max(20),
      employeeId: z.string().trim().min(1).max(30),
      consignmentNo: z.string().trim().min(1).max(50),
      taskType: z.enum(["PICKUP", "DELIVERY"]),
    }).strict().safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "Task assignment details are invalid." }); return; }
    try {
      const result = await runCompanyDataTransaction(
        request.employee!.company.id,
        "shipment.changed",
        (connection) => createLogisticsTask(connection, {
          companyId: request.employee!.company.id,
          managerId: request.employee!.employeeId,
          ...parsed.data,
        }),
        parsed.data.hubId,
        undefined,
        parsed.data.consignmentNo,
      );
      response.status(201).json({ task: result });
    } catch (error) {
      if (error instanceof LogisticsTaskError) { response.status(error.statusCode).json({ error: error.message }); return; }
      next(error);
    }
  },
);

app.get(
  "/api/logistics-executive/tasks",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  async (request, response, next) => {
    const parsed = z.object({
      status: z.enum(["ALL", "PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "FAILED"]).default("ALL"),
      type: z.enum(["PICKUP", "DELIVERY"]).optional(),
      search: z.string().trim().max(64).default(""),
    }).safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: "Task filters are invalid." }); return; }
    try {
      response.json({ tasks: await listExecutiveTasks(pool, request.employee!.company.id, request.employee!.employeeId, parsed.data) });
    } catch (error) { next(error); }
  },
);

app.get(
  "/api/logistics-executive/history",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  async (request, response, next) => {
    const parsed = z.object({
      type: z.enum(["PICKUP", "DELIVERY"]).optional(),
      search: z.string().trim().max(64).default(""),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict().safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: "History filters are invalid." }); return; }
    try {
      response.json({ ...await listExecutiveAssignmentHistory(pool, request.employee!.company.id, request.employee!.employeeId, parsed.data), offset: parsed.data.offset, limit: parsed.data.limit });
    } catch (error) { next(error); }
  },
);

app.get(
  "/api/logistics-executive/history/:taskType/:consignmentNo",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  async (request, response, next) => {
    const taskType = parseTaskType(request.params.taskType ?? "");
    const consignmentNo = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
    if (!taskType || !consignmentNo.success) { response.status(400).json({ error: "History record identifier is invalid." }); return; }
    try {
      const assignment = await getExecutiveAssignmentHistoryDetail(pool, request.employee!.company.id, request.employee!.employeeId, taskType, consignmentNo.data);
      if (!assignment) { response.status(404).json({ error: "Historical assignment was not found in your company and employee scope." }); return; }
      response.json({ assignment });
    } catch (error) { next(error); }
  },
);

app.get(
  "/api/logistics-executive/tasks/:taskType/:consignmentNo",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  async (request, response, next) => {
    const taskType = parseTaskType(request.params.taskType ?? "");
    const consignmentNo = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
    if (!taskType || !consignmentNo.success) { response.status(400).json({ error: "Task identifier is invalid." }); return; }
    try {
      const task = await getExecutiveTaskDetail(pool, request.employee!.company.id, request.employee!.employeeId, taskType, consignmentNo.data);
      if (!task) { response.status(404).json({ error: "Task was not found in your assigned work." }); return; }
      response.json({ task });
    } catch (error) { next(error); }
  },
);

app.post(
  "/api/logistics-executive/tasks/:taskType/:consignmentNo/collections",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  async (request, response, next) => {
    const taskType=parseTaskType(request.params.taskType??"");
    const consignmentNo=z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
    const body=z.object({kind:z.enum(["SHIPPING","COD"]),channel:z.enum(["DEMO_CASH","DEMO_UPI"]),idempotencyKey:z.string().uuid()}).strict().safeParse(request.body);
    if(!taskType||!consignmentNo.success||!body.success){response.status(400).json({error:"Collection request is invalid."});return;}
    try {
      const employee=request.employee!;
      const assignedTask=await getExecutiveTaskDetail(pool,employee.company.id,employee.employeeId,taskType,consignmentNo.data);
      if(!assignedTask){response.status(404).json({error:"Task was not found in your assigned work."});return;}
      const collection=await runCompanyDataTransaction(employee.company.id,"shipment.changed",(connection)=>recordExecutiveCollection(connection,{companyId:employee.company.id,employeeId:employee.employeeId,taskType,consignmentNo:consignmentNo.data,...body.data}),String((assignedTask as RowDataPacket).hubId),undefined,consignmentNo.data);
      response.json({collection});
    }catch(error){if(error instanceof LogisticsTaskError){response.status(error.statusCode).json({error:error.message});return;}next(error);}
  },
);

app.post(
  "/api/logistics-executive/tasks/:taskType/:consignmentNo/actions/:action",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  async (request, response, next) => {
    const taskType = parseTaskType(request.params.taskType ?? "");
    const consignmentNo = z.string().trim().min(1).max(50).safeParse(request.params.consignmentNo);
    const action = parseTaskAction(request.params.action ?? "");
    const parsed = z.object({
      trackingId: z.string().trim().max(50).optional(),
      reason: z.string().trim().max(500).optional(),
    }).strict().safeParse(request.body);
    if (!taskType || !consignmentNo.success || !action || !parsed.success) { response.status(400).json({ error: "Task action is invalid." }); return; }
    try {
      const assignedTask = await getExecutiveTaskDetail(pool, request.employee!.company.id, request.employee!.employeeId, taskType, consignmentNo.data);
      if (!assignedTask) { response.status(404).json({ error: "Task was not found in your assigned work." }); return; }
      const result = await runCompanyDataTransaction(
        request.employee!.company.id,
        "shipment.changed",
        (connection) => performExecutiveTaskAction(connection, {
          companyId: request.employee!.company.id,
          employeeId: request.employee!.employeeId,
          taskType,
          consignmentNo: consignmentNo.data,
          action,
          ...parsed.data,
        }),
        String((assignedTask as RowDataPacket).hubId),
        undefined,
        consignmentNo.data,
      );
      response.json({ task: result });
    } catch (error) {
      if (error instanceof LogisticsTaskError) { response.status(error.statusCode).json({ error: error.message }); return; }
      next(error);
    }
  },
);

app.get(
  "/api/logistics-executive/events",
  requireEmployee,
  requireRole("LOGISTICS_EXECUTIVE"),
  (request, response) => {
    const employee = request.employee!;
    const hubIds = employee.assignedHubs.map((hub) => hub.id);
    response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }).flushHeaders();
    const writeEvent = (name: string, data: unknown, id?: number) => {
      if (id !== undefined) response.write(`id: ${id}\n`);
      response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const subscription = subscribeToCompanyData(employee.company.id, request.header("Last-Event-ID"), (event) => {
      writeEvent("workspace-invalidated", { type: event.type, occurredAt: event.occurredAt }, event.id);
    }, hubIds);
    if (subscription.recoveryRequired) writeEvent("recovery-required", { reason: "event-history-unavailable" });
    else {
      writeEvent("connected", { assignedHubCount: hubIds.length });
      for (const event of subscription.replay) writeEvent("workspace-invalidated", { type: event.type, occurredAt: event.occurredAt }, event.id);
    }
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
    request.on("close", () => { clearInterval(heartbeat); subscription.unsubscribe(); response.end(); });
  },
);

app.get(
  "/api/operations/workspace",
  requireEmployee,
  requireRole("OPERATIONS_MANAGER"),
  async (request, response, next) => {
    try {
      const data = await getOperationsWorkspace(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
      );
      response.json(data);
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/operations/shipments",
  requireEmployee,
  requireRole("OPERATIONS_MANAGER"),
  async (request, response, next) => {
    const parsed = z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      search: z.string().trim().max(64).default(""),
      status: z.string().trim().max(60).default(""),
      hubId: z.string().trim().max(20).default(""),
      origin: z.string().trim().max(100).default(""),
      destination: z.string().trim().max(100).default(""),
      mode: z.string().trim().max(30).default(""),
      risk: z.enum(["", "active", "delayed", "approaching", "stale"]).default(""),
      sortBy: z.enum(["shipmentDate", "status", "expectedDeliveryDate", "consignmentNo"]).default("shipmentDate"),
      direction: z.enum(["asc", "desc"]).default("desc"),
    }).safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Shipment filters are invalid." });
      return;
    }
    try {
      response.json(await listOperationsShipments(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
        parsed.data,
      ));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/operations/shipments/:consignmentNo/events",
  requireEmployee,
  requireRole("OPERATIONS_MANAGER"),
  async (request, response, next) => {
    const consignmentNo = z.string().trim().min(1).max(64).safeParse(request.params.consignmentNo);
    if (!consignmentNo.success) {
      response.status(400).json({ error: "Shipment identifier is invalid." });
      return;
    }
    try {
      const shipment = await getOperationsShipmentEvents(
        pool,
        request.employee!.company.id,
        request.employee!.employeeId,
        consignmentNo.data,
      );
      if (!shipment) {
        response.status(404).json({ error: "Shipment was not found in your assigned-hub scope." });
        return;
      }
      response.json({ shipment });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/operations/events",
  requireEmployee,
  requireRole("OPERATIONS_MANAGER"),
  async (request, response, next) => {
    try {
      const companyId = request.employee!.company.id;
      const hubs = await getOperationsAssignedHubs(pool, companyId, request.employee!.employeeId);
      const hubIds = hubs.map((hub) => hub.hubId);
      response.status(200);
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();

      const writeEvent = (event: string, data: unknown, id?: number) => {
        if (id !== undefined) response.write(`id: ${id}\n`);
        response.write(`event: ${event}\n`);
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      const subscription = subscribeToCompanyData(
        companyId,
        request.header("Last-Event-ID"),
        (event) => {
          writeEvent("workspace-invalidated", {
            type: event.type,
            occurredAt: event.occurredAt,
          }, event.id);
        },
        hubIds,
      );
      if (subscription.recoveryRequired) {
        writeEvent("recovery-required", { reason: "event-history-unavailable" });
      } else {
        writeEvent("connected", { companyId });
        for (const event of subscription.replay) {
          writeEvent("workspace-invalidated", {
            type: event.type,
            occurredAt: event.occurredAt,
          }, event.id);
        }
      }

      const heartbeat = setInterval(() => {
        response.write(": keep-alive\n\n");
      }, 25_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
        response.end();
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/shipping-pricing",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    try {
      const companyId = request.employee!.company.id;
      const [routes] = await pool.execute<RowDataPacket[]>(
        `SELECT r.origin_hub_id AS originHubId,oh.city AS originCity,r.destination_hub_id AS destinationHubId,dh.city AS destinationCity,r.mode
           FROM routes r JOIN hubs oh ON oh.company_id=r.company_id AND oh.hub_id=r.origin_hub_id
           JOIN hubs dh ON dh.company_id=r.company_id AND dh.hub_id=r.destination_hub_id
          WHERE r.company_id=? AND UPPER(oh.status)='ACTIVE' AND UPPER(dh.status)='ACTIVE' ORDER BY oh.city,dh.city,r.mode`, [companyId],
      );
      const [rateRules] = await pool.execute<RowDataPacket[]>(
        `SELECT rate_rule_id AS rateRuleId,origin_hub_id AS originHubId,destination_hub_id AS destinationHubId,mode,
                base_charge AS baseCharge,included_weight_kg AS includedWeightKg,per_kg_charge AS perKgCharge,
                service_charge AS serviceCharge,minimum_charge AS minimumCharge,tax_rate_percent AS taxRatePercent,
                volumetric_divisor AS volumetricDivisor,active
           FROM company_shipping_rate_rules WHERE company_id=? ORDER BY origin_hub_id,destination_hub_id,mode`, [companyId],
      );
      const [settings] = await pool.execute<RowDataPacket[]>(
        `SELECT sender_pays_enabled AS senderPaysEnabled,receiver_pays_enabled AS receiverPaysEnabled,
                demo_upi_enabled AS demoUpiEnabled,pay_at_pickup_enabled AS payAtPickupEnabled,
                pay_at_delivery_enabled AS payAtDeliveryEnabled,cod_enabled AS codEnabled
           FROM company_payment_settings WHERE company_id=? LIMIT 1`, [companyId],
      );
      response.json({ routes, rateRules, settings: settings[0] ?? { senderPaysEnabled: 1, receiverPaysEnabled: 1, demoUpiEnabled: 0, payAtPickupEnabled: 0, payAtDeliveryEnabled: 0, codEnabled: 0 } });
    } catch (error) { next(error); }
  },
);

app.put(
  "/api/company-admin/shipping-pricing",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const ruleSchema = z.object({
      originHubId: z.string().trim().min(1).max(20), destinationHubId: z.string().trim().min(1).max(20), mode: z.string().trim().min(1).max(30),
      baseCharge: z.number().min(0).max(10000000), includedWeightKg: z.number().positive().max(10000), perKgCharge: z.number().min(0).max(1000000),
      serviceCharge: z.number().min(0).max(1000000), minimumCharge: z.number().min(0).max(10000000), taxRatePercent: z.number().min(0).max(100),
      volumetricDivisor: z.number().positive().max(100000).nullable(), active: z.boolean(),
    }).strict();
    const schema = z.object({
      settings: z.object({ senderPaysEnabled: z.boolean(), receiverPaysEnabled: z.boolean(), demoUpiEnabled: z.boolean(), payAtPickupEnabled: z.boolean(), payAtDeliveryEnabled: z.boolean(), codEnabled: z.boolean() }).strict(),
      rateRules: z.array(ruleSchema).max(100),
    }).strict();
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "Provide valid company payment settings and rate rules." }); return; }
    const rules = parsed.data.rateRules;
    if (new Set(rules.map((rule) => `${rule.originHubId}|${rule.destinationHubId}|${rule.mode.toLowerCase()}`)).size !== rules.length) { response.status(400).json({ error: "Each route and service mode can have only one pricing rule." }); return; }
    if(rules.some(rule=>rule.baseCharge+rule.perKgCharge+rule.serviceCharge+rule.minimumCharge<=0)){response.status(400).json({error:"Each rate needs at least one positive charge component."});return;}
    const companyId = request.employee!.company.id;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("UPDATE company_shipping_rate_rules SET active=0 WHERE company_id=?",[companyId]);
      for (const rule of rules) {
        const [validRoutes] = await connection.execute<RowDataPacket[]>(
          `SELECT 1 FROM routes r JOIN hubs oh ON oh.company_id=r.company_id AND oh.hub_id=r.origin_hub_id
             JOIN hubs dh ON dh.company_id=r.company_id AND dh.hub_id=r.destination_hub_id
            WHERE r.company_id=? AND r.origin_hub_id=? AND r.destination_hub_id=? AND LOWER(r.mode)=LOWER(?)
              AND UPPER(oh.status)='ACTIVE' AND UPPER(dh.status)='ACTIVE' LIMIT 1 FOR UPDATE`,
          [companyId, rule.originHubId, rule.destinationHubId, rule.mode],
        );
        if (!validRoutes.length) { await connection.rollback(); response.status(400).json({ error: `Route ${rule.originHubId} → ${rule.destinationHubId} (${rule.mode}) is not active for this company.` }); return; }
        await connection.execute(
          `INSERT INTO company_shipping_rate_rules (company_id,origin_hub_id,destination_hub_id,mode,base_charge,included_weight_kg,per_kg_charge,service_charge,minimum_charge,tax_rate_percent,volumetric_divisor,active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE base_charge=VALUES(base_charge),included_weight_kg=VALUES(included_weight_kg),per_kg_charge=VALUES(per_kg_charge),service_charge=VALUES(service_charge),minimum_charge=VALUES(minimum_charge),tax_rate_percent=VALUES(tax_rate_percent),volumetric_divisor=VALUES(volumetric_divisor),active=VALUES(active),updated_at=CURRENT_TIMESTAMP()`,
          [companyId,rule.originHubId,rule.destinationHubId,rule.mode,rule.baseCharge,rule.includedWeightKg,rule.perKgCharge,rule.serviceCharge,rule.minimumCharge,rule.taxRatePercent,rule.volumetricDivisor,rule.active?1:0],
        );
      }
      const setting = parsed.data.settings;
      await connection.execute(
        `INSERT INTO company_payment_settings (company_id,sender_pays_enabled,receiver_pays_enabled,demo_upi_enabled,pay_at_pickup_enabled,pay_at_delivery_enabled,cod_enabled,updated_by_employee_id)
         VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sender_pays_enabled=VALUES(sender_pays_enabled),receiver_pays_enabled=VALUES(receiver_pays_enabled),demo_upi_enabled=VALUES(demo_upi_enabled),pay_at_pickup_enabled=VALUES(pay_at_pickup_enabled),pay_at_delivery_enabled=VALUES(pay_at_delivery_enabled),cod_enabled=VALUES(cod_enabled),updated_by_employee_id=VALUES(updated_by_employee_id),updated_at=CURRENT_TIMESTAMP()`,
        [companyId,setting.senderPaysEnabled?1:0,setting.receiverPaysEnabled?1:0,setting.demoUpiEnabled?1:0,setting.payAtPickupEnabled?1:0,setting.payAtDeliveryEnabled?1:0,setting.codEnabled?1:0,request.employee!.employeeId],
      );
      await connection.commit();
      response.json({ saved: true, rateRuleCount: rules.length });
    } catch (error) { await connection.rollback().catch(() => undefined); next(error); }
    finally { connection.release(); }
  },
);

app.get(
  "/api/company-admin/events",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  (request, response) => {
    const companyId = request.employee!.company.id;
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    const writeEvent = (event: string, data: unknown, id?: number) => {
      if (id !== undefined) response.write(`id: ${id}\n`);
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const subscription = subscribeToCompanyData(
      companyId,
      request.header("Last-Event-ID"),
      (event) => {
        writeEvent("company-data-changed", {
          type: event.type,
          occurredAt: event.occurredAt,
        }, event.id);
      },
    );
    if (subscription.recoveryRequired) {
      writeEvent("recovery-required", { reason: "event-history-unavailable" });
    } else {
      writeEvent("connected", { companyId });
      for (const event of subscription.replay) {
        writeEvent("company-data-changed", {
          type: event.type,
          occurredAt: event.occurredAt,
        }, event.id);
      }
    }

    const heartbeat = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, 25_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      response.end();
    });
  },
);

app.get(
  "/api/company-admin/dashboard",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    try {
      const startDate = parseIsoDate(
        typeof request.query.startDate === "string" ? request.query.startDate : undefined,
        "startDate",
      );
      const endDate = parseIsoDate(
        typeof request.query.endDate === "string" ? request.query.endDate : undefined,
        "endDate",
      );
      if (request.query.startDate !== undefined && !startDate) {
        response.status(400).json({ error: "startDate must be a single YYYY-MM-DD value." });
        return;
      }
      if (request.query.endDate !== undefined && !endDate) {
        response.status(400).json({ error: "endDate must be a single YYYY-MM-DD value." });
        return;
      }
      if (startDate && endDate && startDate > endDate) {
        response.status(400).json({ error: "startDate must not be after endDate." });
        return;
      }
      const dashboard = await getCompanyAdminDashboard(request.employee!.company.id, {
        startDate: startDate ?? "",
        endDate: endDate ?? "",
      });
      response.json(dashboard);
    } catch (error) {
      if (error instanceof Error && /must use|valid calendar date/.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/shipments",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const parsedFilters = z.object({
      status: z.string().trim().min(1).max(60).optional(),
      routeId: z.string().trim().min(1).max(64).optional(),
      hubId: z.string().trim().min(1).max(64).optional(),
      customerId: z.string().trim().min(1).max(64).optional(),
      consignmentNo: z.string().trim().min(1).max(64).optional(),
    }).safeParse(request.query);
    if (!parsedFilters.success) {
      response.status(400).json({ error: "Shipment filters are invalid." });
      return;
    }
    try {
      const startDate = parseIsoDate(
        typeof request.query.startDate === "string" ? request.query.startDate : undefined,
        "startDate",
      );
      const endDate = parseIsoDate(
        typeof request.query.endDate === "string" ? request.query.endDate : undefined,
        "endDate",
      );
      if (startDate && endDate && startDate > endDate) {
        response.status(400).json({ error: "startDate must not be after endDate." });
        return;
      }
      const shipments = await listCompanyShipments(
        request.employee!.company.id,
        { startDate, endDate },
        {
          status: parsedFilters.data.status ?? null,
          routeId: parsedFilters.data.routeId ?? null,
          hubId: parsedFilters.data.hubId ?? null,
          customerId: parsedFilters.data.customerId ?? null,
          consignmentNo: parsedFilters.data.consignmentNo ?? null,
        },
      );
      response.json({ shipments, limit: 50 });
    } catch (error) {
      if (error instanceof Error && /must use|valid calendar date/.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/shipments/:consignmentNo/events",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const consignmentNo = z.string().trim().min(1).max(64).safeParse(request.params.consignmentNo);
    if (!consignmentNo.success) {
      response.status(400).json({ error: "Shipment identifier is invalid." });
      return;
    }
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT se.event_id AS eventId, se.event_time AS eventTime,
                se.event_type AS eventType, se.event_status AS eventStatus,
                se.hub_id AS hubId, h.city AS hubCity
           FROM shipment_events se
           JOIN shipments s ON s.consignment_no = se.consignment_no
           LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
          WHERE s.company_id = ? AND s.consignment_no = ?
            AND (SELECT COUNT(*) FROM shipments same_id
                  WHERE same_id.consignment_no = s.consignment_no) = 1
          ORDER BY se.event_time DESC, se.event_id DESC
          LIMIT 100`,
        [request.employee!.company.id, consignmentNo.data],
      );
      response.json({ events: rows });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/employee-management/hubs",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    try {
      const [hubs] = await pool.execute<RowDataPacket[]>(
        `SELECT hub_id AS hubId, city
           FROM hubs
          WHERE company_id = ? AND status = 'Active'
          ORDER BY city, hub_id`,
        [request.employee!.company.id],
      );
      response.json({ hubs, roles: employeeRoles });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/employees/:employeeId",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const employeeId = z.string().trim().min(1).max(30).safeParse(request.params.employeeId);
    if (!employeeId.success) {
      response.status(400).json({ error: "Employee ID is invalid." });
      return;
    }
    try {
      const [employees] = await pool.execute<RowDataPacket[]>(
        `SELECT employee_id AS employeeId, name,
                CASE WHEN UPPER(role) = 'ADMIN' THEN 'COMPANY_ADMIN' ELSE UPPER(role) END AS role,
                email, phone, status
           FROM employees
          WHERE company_id = ? AND employee_id = ?
          LIMIT 1`,
        [request.employee!.company.id, employeeId.data],
      );
      if (!employees[0]) {
        response.status(404).json({ error: "Employee was not found for this company." });
        return;
      }
      const [assignments] = await pool.execute<RowDataPacket[]>(
        `SELECT eh.hub_id AS hubId
           FROM employee_hubs eh
           JOIN hubs h ON h.hub_id = eh.hub_id
          WHERE eh.employee_id = ? AND eh.status = 'Active'
            AND h.company_id = ? AND h.status = 'Active'
          ORDER BY h.city, h.hub_id`,
        [employeeId.data, request.employee!.company.id],
      );
      response.json({
        employee: employees[0],
        hubIds: assignments.map((assignment) => assignment.hubId),
      });
    } catch (error) {
      next(error);
    }
  },
);

const employeeManagementSchema = z.object({
  name: z.string().trim().min(1).max(150),
  role: z.enum(employeeRoles),
  email: z.string().trim().email().max(150).nullable(),
  phone: z.string().trim().max(20).regex(/^[+0-9 ()-]*$/).nullable(),
  status: z.enum(["Active", "Inactive"]),
  hubIds: z.array(z.string().trim().min(1).max(20)).max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Hub assignments must be unique."),
}).strict();

app.post(
  "/api/company-admin/employees",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const parsed = z.object({
      employeeId: z.string().trim().min(1).max(30),
      password: z.string().min(12).max(1024),
      ...employeeManagementSchema.shape,
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Employee details are invalid. New passwords must be at least 12 characters." });
      return;
    }
    const { employeeId, password, ...input } = parsed.data;
    try {
      const employee = await runCompanyDataTransaction(
        request.employee!.company.id,
        "company-data.changed",
        (connection) =>
          createCompanyEmployee(connection, request.employee!.company.id, employeeId, password, {
            ...input,
            role: input.role,
          }),
      );
      response.status(201).json({ employee });
    } catch (error) {
      if (error instanceof EmployeeManagementError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        response.status(409).json({ error: "Employee ID, email, or account details already exist." });
        return;
      }
      next(error);
    }
  },
);

app.patch(
  "/api/company-admin/employees/:employeeId",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const employeeId = z.string().trim().min(1).max(30).safeParse(request.params.employeeId);
    const parsed = employeeManagementSchema.extend({
      password: z.string().refine(isValidResetPassword).optional(),
    }).safeParse(request.body);
    if (!employeeId.success || !parsed.success) {
      response.status(400).json({ error: "Employee details are invalid. Reset passwords must be 12 through 1024 characters." });
      return;
    }
    const { password, ...employeeInput } = parsed.data;
    try {
      const employee = await runCompanyDataTransaction(
        request.employee!.company.id,
        "company-data.changed",
        (connection) =>
          updateCompanyEmployee(
            connection,
            request.employee!.company.id,
            request.employee!.employeeId,
            employeeId.data,
            { ...employeeInput, role: employeeInput.role },
            password,
          ),
      );
      response.json({ employee });
    } catch (error) {
      if (error instanceof EmployeeManagementError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        response.status(409).json({ error: "Email is already assigned to another employee." });
        return;
      }
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/assistant/status",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  (_request, response) => {
    response.json({
      configured: false,
      message: "Configure an approved logistics assistant provider and server-side credentials before enabling answers.",
    });
  },
);

app.post(
  "/api/company-admin/assistant/query",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  (request, response) => {
    const parsed = z.object({
      question: z.string().trim().min(1).max(500),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Enter a logistics operations question up to 500 characters." });
      return;
    }
    response.status(503).json({
      error: "The Logistics Admin Assistant is not connected. Configure an approved provider before requesting company analytics answers.",
    });
  },
);

app.get(
  "/api/company-admin/customers/:customerId/details",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const customerId = z.string().trim().min(1).max(20).safeParse(request.params.customerId);
    if (!customerId.success) {
      response.status(400).json({ error: "Customer ID is invalid." });
      return;
    }
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT customer_id AS customerId, customer_name AS customerName,
                customer_phone AS phone, customer_city AS city,
                customer_state AS state, customer_pincode AS pincode
           FROM customers WHERE company_id = ? AND customer_id = ? LIMIT 1`,
        [request.employee!.company.id, customerId.data],
      );
      if (!rows[0]) {
        response.status(404).json({ error: "Customer was not found for this company." });
        return;
      }
      response.json({ customer: rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/hubs/:hubId/details",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const hubId = z.string().trim().min(1).max(20).safeParse(request.params.hubId);
    if (!hubId.success) {
      response.status(400).json({ error: "Hub ID is invalid." });
      return;
    }
    try {
      const [hubRows] = await pool.execute<RowDataPacket[]>(
        `SELECT h.hub_id AS hubId, h.city, h.status,
                COUNT(DISTINCT s.consignment_no) AS shipmentLegs,
                COUNT(DISTINCT CASE
                  WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                    AND s.actual_transit_days IS NOT NULL
                  THEN s.consignment_no END) AS eligibleDelivered,
                COUNT(DISTINCT CASE
                  WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                    AND s.actual_transit_days IS NOT NULL
                    AND s.actual_transit_days > COALESCE(s.sla_days, 4)
                  THEN s.consignment_no END) AS historicallyDelayed,
                ROUND(AVG(CASE
                  WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                    AND s.actual_transit_days IS NOT NULL
                  THEN s.actual_transit_days END), 1) AS averageTransitDays
           FROM hubs h
           LEFT JOIN shipments s
             ON s.company_id = h.company_id
            AND (s.origin_hub_id = h.hub_id OR s.destination_hub_id = h.hub_id)
          WHERE h.company_id = ? AND h.hub_id = ?
          GROUP BY h.hub_id, h.city, h.status
          LIMIT 1`,
        [request.employee!.company.id, hubId.data],
      );
      if (!hubRows[0]) {
        response.status(404).json({ error: "Hub was not found for this company." });
        return;
      }
      const [employees] = await pool.execute<RowDataPacket[]>(
        `SELECT e.employee_id AS employeeId, e.name,
                CASE WHEN UPPER(e.role) = 'ADMIN' THEN 'COMPANY_ADMIN' ELSE UPPER(e.role) END AS role
           FROM employee_hubs eh
           JOIN employees e ON e.employee_id = eh.employee_id
          WHERE eh.hub_id = ? AND eh.status = 'Active'
            AND e.company_id = ? AND e.status = 'Active'
          ORDER BY e.name, e.employee_id`,
        [hubId.data, request.employee!.company.id],
      );
      response.json({ hub: hubRows[0], employees });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/records/:kind",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const kind = z.enum([
      "shipments",
      "customers",
      "employees",
      "hubs",
      "routes",
      "exceptions",
    ]).safeParse(request.params.kind);
    const parsed = z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      pageSize: z.coerce.number().int().min(10).max(100).default(25),
      q: z.string().trim().max(80).default(""),
      sortBy: z.string().trim().max(32).default(""),
      direction: z.enum(["asc", "desc"]).default("desc"),
      status: z.string().trim().max(60).default(""),
      mode: z.string().trim().max(60).default(""),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }).safeParse(request.query);
    if (!kind.success || !parsed.success) {
      response.status(400).json({ error: "Record filters are invalid." });
      return;
    }
    try {
      const startDate = parseIsoDate(parsed.data.startDate, "startDate");
      const endDate = parseIsoDate(parsed.data.endDate, "endDate");
      if (startDate && endDate && startDate > endDate) {
        response.status(400).json({ error: "startDate must not be after endDate." });
        return;
      }
      const result = await listCompanyRecords(
        request.employee!.company.id,
        kind.data,
        {
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          search: parsed.data.q,
          sortBy: parsed.data.sortBy,
          direction: parsed.data.direction,
          status: parsed.data.status,
          mode: parsed.data.mode,
          startDate: startDate ?? "",
          endDate: endDate ?? "",
        },
      );
      response.json(result);
    } catch (error) {
      if (error instanceof Error && /must use|valid calendar date/.test(error.message)) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/search",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    const parsed = z.string().trim().min(2).max(80).safeParse(request.query.q);
    if (!parsed.success) {
      response.status(400).json({ error: "Search must be between 2 and 80 characters." });
      return;
    }
    try {
      const results = await searchCompanyRecords(
        request.employee!.company.id,
        parsed.data,
      );
      response.json({ results });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/company-admin/overview",
  requireEmployee,
  requireRole("COMPANY_ADMIN"),
  async (request, response, next) => {
    try {
      const companyId = request.employee!.company.id;
      const [employeeRows] = await pool.execute<CountRow[]>(
        "SELECT COUNT(*) AS total FROM employees WHERE company_id = ?",
        [companyId],
      );
      const [hubRows] = await pool.execute<CountRow[]>(
        "SELECT COUNT(*) AS total FROM hubs WHERE company_id = ? AND LOWER(status) = 'active'",
        [companyId],
      );
      const [shipmentRows] = await pool.execute<CountRow[]>(
        "SELECT COUNT(*) AS total FROM shipments WHERE company_id = ?",
        [companyId],
      );
      response.json({
        employees: employeeRows[0]?.total ?? 0,
        activeHubs: hubRows[0]?.total ?? 0,
        shipments: shipmentRows[0]?.total ?? 0,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.use((_request, response) => {
  response.status(404).json({ error: "Not found." });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(
    "API request failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  if (response.headersSent) {
    return;
  }
  response.status(500).json({ error: "The request could not be completed." });
};
app.use(errorHandler);

async function start(): Promise<void> {
  await pool.query("SELECT 1");
  app.listen(config.port, () => {
    console.log(`Logix AI API listening on port ${config.port}.`);
  });
}

start().catch((error: unknown) => {
  console.error(
    "API startup failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});

export { app };

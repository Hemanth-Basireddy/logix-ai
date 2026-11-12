import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { z } from "zod";
import { brandingForCompany, config } from "./config.js";
import { runCompanyDataTransaction } from "./company-events.js";
import { customerPhoneKey } from "./customer-phone.js";
import { pool } from "./db.js";

export const customerCookieName = "logix_customer_session";
const sessionLifetimeSeconds = 60 * 60 * 8;
const credentialsSchema = z.object({
  identifier: z.string().trim().min(4).max(254),
  password: z.string().min(1).max(1024),
}).strict();
const registrationCredentialsSchema = z.object({
  email: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().email().max(254).transform((value) => value.toLowerCase()).optional()),
  password: z.string().min(12).max(1024),
}).strict();
const registerSchema = registrationCredentialsSchema.extend({
  confirmPassword: z.string().min(12).max(1024),
  name: z.string().trim().min(2).max(255),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/),
  address: z.string().trim().min(5).max(2000),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  pincode: z.string().trim().regex(/^\d{6}$/),
}).strict().refine((value) => value.password === value.confirmPassword, { message: "Passwords do not match." });
const quoteRequestFields = z.object({
  originHubId: z.string().trim().min(1).max(20),
  destinationHubId: z.string().trim().min(1).max(20),
  mode: z.string().trim().min(1).max(30),
  weightKg: z.number().positive().max(10000),
  lengthCm: z.number().positive().max(500).optional(),
  widthCm: z.number().positive().max(500).optional(),
  heightCm: z.number().positive().max(500).optional(),
}).strict();
const quoteRequestSchema = quoteRequestFields.refine((value) => value.originHubId !== value.destinationHubId, { message: "Origin and destination must be different." }).refine((value) => {
    const count = [value.lengthCm, value.widthCm, value.heightCm].filter((item) => item !== undefined).length;
    return count === 0 || count === 3;
  }, { message: "Enter all three package dimensions or leave all dimensions empty." });
const bookingSchema = quoteRequestFields.extend({
  idempotencyKey: z.string().uuid(),
  pieces: z.number().int().min(1).max(1000),
  chargePayer: z.enum(["SENDER", "RECEIVER"]),
  collectionMethod: z.enum(["DEMO_UPI", "PAY_AT_PICKUP", "PAY_AT_DELIVERY"]).optional(),
  codAmount: z.number().min(0).max(10000000).optional(),
  sender: z.object({ name: z.string().trim().min(2).max(255), phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/), address: z.string().trim().min(5).max(2000), city: z.string().trim().min(2).max(100), state: z.string().trim().min(2).max(100), pincode: z.string().trim().regex(/^\d{6}$/) }).strict(),
  recipient: z.object({ name: z.string().trim().min(2).max(255), phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/), address: z.string().trim().min(5).max(2000), city: z.string().trim().min(2).max(100), state: z.string().trim().min(2).max(100), pincode: z.string().trim().regex(/^\d{6}$/) }).strict(),
}).strict().refine((value) => value.originHubId !== value.destinationHubId, { message: "Origin and destination must be different." }).refine((value) => {
  const count = [value.lengthCm, value.widthCm, value.heightCm].filter((item) => item !== undefined).length;
  return count === 0 || count === 3;
}, { message: "Enter all three package dimensions or leave all dimensions empty." });

type CustomerRow = RowDataPacket & { customer_account_id: number; company_id: number; customer_id: string; email: string | null; password_hash: string | null; customer_name: string; customer_phone: string; customer_address: string; customer_city: string; customer_state: string; customer_pincode: string };
type AuthCustomer = { accountId: number; companyId: number; customerId: string; email: string | null; name: string };
declare global { namespace Express { interface Request { customer?: AuthCustomer } } }

function configuredCompany(response: Response): number | null {
  if (config.customerPortalCompanyId === null) {
    response.status(503).json({ error: "Customer booking is not configured for this deployment." });
    return null;
  }
  return config.customerPortalCompanyId;
}
function setCustomerCookie(response: Response, accountId: number, companyId: number): void {
  const token = jwt.sign({ sub: String(accountId), companyId, kind: "customer" }, config.jwtSecret, { algorithm: "HS256", expiresIn: sessionLifetimeSeconds });
  response.cookie(customerCookieName, token, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/api/customer", maxAge: sessionLifetimeSeconds * 1000 });
}
async function loadCustomer(accountId: number, companyId: number): Promise<AuthCustomer | null> {
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT a.customer_account_id,a.company_id,a.customer_id,a.email,c.customer_name,c.customer_phone,c.customer_address,c.customer_city,c.customer_state,c.customer_pincode
       FROM customer_accounts a JOIN customers c ON c.customer_id=a.customer_id AND c.company_id=a.company_id
      WHERE a.customer_account_id=? AND a.company_id=? LIMIT 1`, [accountId, companyId]);
  const row = rows[0];
  return row ? { accountId: Number(row.customer_account_id), companyId: Number(row.company_id), customerId: row.customer_id, email: row.email, name: row.customer_name } : null;
}
export async function requireCustomer(request: Request, response: Response, next: NextFunction): Promise<void> {
  try {
    const activeCompanyId = await resolveCustomerCompanyId();
    if (activeCompanyId === null) { response.status(503).json({ error: "Customer booking is unavailable for this company." }); return; }
    const raw = request.cookies?.[customerCookieName];
    if (!raw) { response.status(401).json({ error: "Sign in required." }); return; }
    const token = jwt.verify(raw, config.jwtSecret, { algorithms: ["HS256"] });
    if (typeof token === "string" || token.kind !== "customer" || typeof token.sub !== "string" || typeof token.companyId !== "number" || token.companyId !== activeCompanyId) {
      response.status(401).json({ error: "Sign in required." }); return;
    }
    const customer = await loadCustomer(Number(token.sub), token.companyId);
    if (!customer) { response.status(401).json({ error: "Sign in required." }); return; }
    request.customer = customer;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) { response.status(401).json({ error: "Sign in required." }); return; }
    next(error);
  }
}
export async function optionalCustomer(request: Request): Promise<AuthCustomer | null> {
  const raw = request.cookies?.[customerCookieName];
  const activeCompanyId = await resolveCustomerCompanyId();
  if (!raw || activeCompanyId === null) return null;
  try {
    const token = jwt.verify(raw, config.jwtSecret, { algorithms: ["HS256"] });
    if (typeof token === "string" || token.kind !== "customer" || typeof token.sub !== "string" || token.companyId !== activeCompanyId) return null;
    return loadCustomer(Number(token.sub), token.companyId);
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) return null;
    throw error;
  }
}
export function clearCustomerCookie(response: Response): void {
  response.clearCookie(customerCookieName, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", path: "/api/customer" });
}

export async function resolveCustomerCompanyId(): Promise<number | null> {
  const companyId = config.customerPortalCompanyId;
  if (companyId === null) return null;
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT company_id FROM companies WHERE company_id = ? AND UPPER(status) = 'ACTIVE' LIMIT 1",
    [companyId],
  );
  return rows.length ? companyId : null;
}

export function registerCustomer(companyId: number, input: z.infer<typeof registerSchema>) {
  return runCompanyDataTransaction(companyId, "company-data.changed", async (connection) => {
    const phoneKey = customerPhoneKey(input.phone);
    const [existing] = await connection.execute<RowDataPacket[]>(
      "SELECT customer_id FROM customers WHERE company_id=? AND customer_phone_normalized=? LIMIT 2 FOR UPDATE",
      [companyId, phoneKey],
    );
    if (existing.length) throw new CustomerPortalError("This phone is already linked to an existing customer. Sign in using the registered name for its first demo login, or contact support.", 409);
    const customerId = `CUS${randomBytes(8).toString("hex").toUpperCase()}`;
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await connection.execute<ResultSetHeader>(
      `INSERT INTO customers (customer_id,company_id,customer_name,customer_phone,customer_phone_normalized,customer_address,customer_city,customer_state,customer_pincode) VALUES (?,?,?,?,?,?,?,?,?)`,
      [customerId, companyId, input.name, input.phone, phoneKey, input.address, input.city, input.state, input.pincode]);
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO customer_accounts (company_id,customer_id,email,password_hash) VALUES (?,?,?,?)`,
      [companyId, customerId, input.email ?? null, passwordHash]);
    return { accountId: result.insertId, customerId, email: input.email ?? null, name: input.name };
  });
}

export async function listCustomerHubs(companyId: number) {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT hub_id AS hubId,city FROM hubs WHERE company_id=? AND UPPER(status)='ACTIVE' ORDER BY city,hub_id`, [companyId]);
  const [modes] = await pool.execute<RowDataPacket[]>(`SELECT DISTINCT r.mode FROM routes r JOIN hubs o ON o.hub_id=r.origin_hub_id AND o.company_id=r.company_id JOIN hubs d ON d.hub_id=r.destination_hub_id AND d.company_id=r.company_id WHERE r.company_id=? AND UPPER(o.status)='ACTIVE' AND UPPER(d.status)='ACTIVE' ORDER BY r.mode`,[companyId]);
  return { hubs: rows, modes: modes.map(row=>String(row.mode)) };
}
export async function loginCustomer(companyId: number, identifier: string, password: string): Promise<AuthCustomer | null> {
  const isEmail = identifier.includes("@");
  const lookup = isEmail ? identifier.trim().toLowerCase() : customerPhoneKey(identifier);
  if (!isEmail && (lookup.length < 4 || lookup.length > 15)) return null;
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT a.customer_account_id,a.company_id,a.customer_id,a.email,a.password_hash,c.customer_name,c.customer_phone,c.customer_address,c.customer_city,c.customer_state,c.customer_pincode
       FROM customer_accounts a JOIN customers c ON c.customer_id=a.customer_id AND c.company_id=a.company_id
      WHERE a.company_id=? AND ${isEmail ? "LOWER(a.email)=?" : "c.customer_phone_normalized=?"} LIMIT 2`, [companyId,lookup]);
  if (rows.length > 1) return null;
  if (rows.length === 1 && rows[0]) {
    const row = rows[0];
    if (row.password_hash?.startsWith("$argon2id$") && await argon2.verify(row.password_hash, password)) {
      return { accountId: Number(row.customer_account_id), companyId: Number(row.company_id), customerId: row.customer_id, email: row.email, name: row.customer_name };
    }
    if (isEmail || row.password_hash || config.customerPortalMode !== "demo" || password !== row.customer_name) return null;
  } else if (isEmail || config.customerPortalMode !== "demo") return null;

  // Historical demo customers can claim the existing record once using its exact
  // registered name. Locking the company-scoped customer prevents duplicate accounts.
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [matches] = await connection.execute<Array<RowDataPacket & { customer_id: string; customer_name: string }>>(
      "SELECT customer_id,customer_name FROM customers WHERE company_id=? AND customer_phone_normalized=? ORDER BY customer_id LIMIT 2 FOR UPDATE",
      [companyId, lookup],
    );
    if (matches.length !== 1 || password !== String(matches[0]!.customer_name)) { await connection.rollback(); return null; }
    const customerId = String(matches[0]!.customer_id);
    const [accounts] = await connection.execute<Array<RowDataPacket & { customer_account_id: number; email: string | null; password_hash: string | null }>>(
      "SELECT customer_account_id,email,password_hash FROM customer_accounts WHERE company_id=? AND customer_id=? FOR UPDATE",
      [companyId, customerId],
    );
    if (accounts[0]?.password_hash) {
      const hash = String(accounts[0].password_hash);
      if (hash.startsWith("$argon2id$") && await argon2.verify(hash, password)) {
        await connection.commit();
        return { accountId: Number(accounts[0].customer_account_id), companyId, customerId, email: accounts[0].email ?? null, name: String(matches[0]!.customer_name) };
      }
      await connection.rollback();
      return null;
    }
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    let accountId: number;
    if (accounts[0]) {
      const [updated] = await connection.execute<ResultSetHeader>(
        "UPDATE customer_accounts SET password_hash=? WHERE company_id=? AND customer_id=? AND password_hash IS NULL",
        [hash, companyId, customerId],
      );
      if (updated.affectedRows !== 1) { await connection.rollback(); return null; }
      accountId = Number(accounts[0].customer_account_id);
    } else {
      const [created] = await connection.execute<ResultSetHeader>(
        "INSERT INTO customer_accounts (company_id,customer_id,email,password_hash) VALUES (?,?,NULL,?)",
        [companyId, customerId, hash],
      );
      accountId = Number(created.insertId);
    }
    await connection.commit();
    return { accountId, companyId, customerId, email: accounts[0]?.email ?? null, name: String(matches[0]!.customer_name) };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally { connection.release(); }
}

type QuoteInput = z.infer<typeof quoteRequestSchema>;
type QuoteRow = RowDataPacket & { rateRuleId: number; baseCharge: string | number; includedWeightKg: string | number; perKgCharge: string | number; serviceCharge: string | number; minimumCharge: string | number; taxRatePercent: string | number; volumetricDivisor: string | number | null };

export async function getCustomerShippingQuote(executor: Pool | PoolConnection, companyId: number, input: QuoteInput) {
  const [routes] = await executor.execute<RowDataPacket[]>(
    `SELECT 1 FROM routes r JOIN hubs o ON o.hub_id=r.origin_hub_id AND o.company_id=r.company_id
      JOIN hubs d ON d.hub_id=r.destination_hub_id AND d.company_id=r.company_id
     WHERE r.company_id=? AND UPPER(o.status)='ACTIVE' AND UPPER(d.status)='ACTIVE'
       AND r.origin_hub_id=? AND r.destination_hub_id=? AND LOWER(r.mode)=LOWER(?) LIMIT 1`,
    [companyId, input.originHubId, input.destinationHubId, input.mode],
  );
  if (!routes.length) throw new CustomerPortalError("No active route is configured for this origin, destination, and service mode.", 400);
  const [rateRows] = await executor.execute<QuoteRow[]>(
    `SELECT rate_rule_id AS rateRuleId,base_charge AS baseCharge,included_weight_kg AS includedWeightKg,
            per_kg_charge AS perKgCharge,service_charge AS serviceCharge,minimum_charge AS minimumCharge,tax_rate_percent AS taxRatePercent,
            volumetric_divisor AS volumetricDivisor
       FROM company_shipping_rate_rules
      WHERE company_id=? AND origin_hub_id=? AND destination_hub_id=? AND LOWER(mode)=LOWER(?) AND active=1 LIMIT 1`,
    [companyId, input.originHubId, input.destinationHubId, input.mode],
  );
  const [settingRows] = await executor.execute<Array<RowDataPacket & { senderPaysEnabled?: number; receiverPaysEnabled?: number; demoUpiEnabled?: number; payAtPickupEnabled?: number; payAtDeliveryEnabled?: number; codEnabled?: number }>>(
    `SELECT sender_pays_enabled AS senderPaysEnabled,receiver_pays_enabled AS receiverPaysEnabled,
            demo_upi_enabled AS demoUpiEnabled,pay_at_pickup_enabled AS payAtPickupEnabled,
            pay_at_delivery_enabled AS payAtDeliveryEnabled,cod_enabled AS codEnabled
       FROM company_payment_settings WHERE company_id=? LIMIT 1`,
    [companyId],
  );
  const settings: { senderPaysEnabled?: number; receiverPaysEnabled?: number; demoUpiEnabled?: number; payAtPickupEnabled?: number; payAtDeliveryEnabled?: number; codEnabled?: number } = settingRows[0] ?? {};
  const payers = { SENDER: settings.senderPaysEnabled === undefined ? true : Boolean(settings.senderPaysEnabled), RECEIVER: settings.receiverPaysEnabled === undefined ? true : Boolean(settings.receiverPaysEnabled) };
  const methods = {
    DEMO_UPI: Boolean(settings.demoUpiEnabled) && config.demoPaymentsEnabled,
    PAY_AT_PICKUP: Boolean(settings.payAtPickupEnabled),
    PAY_AT_DELIVERY: Boolean(settings.payAtDeliveryEnabled),
  };
  const rate = rateRows[0];
  if (!rate) return { available: false, reason: "No company rate is configured for this route and service.", methods, payers, codEnabled: Boolean(settings.codEnabled) };
  const dimensionsSupplied = input.lengthCm !== undefined && input.widthCm !== undefined && input.heightCm !== undefined;
  const volumetricWeight = dimensionsSupplied && rate.volumetricDivisor && Number(rate.volumetricDivisor) > 0
    ? (input.lengthCm! * input.widthCm! * input.heightCm!) / Number(rate.volumetricDivisor)
    : 0;
  const chargeableWeight = Math.max(input.weightKg, volumetricWeight);
  const base = Number(rate.baseCharge);
  const weightCharge = Math.max(0, chargeableWeight - Number(rate.includedWeightKg)) * Number(rate.perKgCharge);
  const service = Number(rate.serviceCharge);
  const subtotal = base + weightCharge + service;
  const minimumAdjustment = Math.max(0, Number(rate.minimumCharge) - subtotal);
  const taxable = subtotal + minimumAdjustment;
  const tax = taxable * Number(rate.taxRatePercent) / 100;
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  return {
    available: true,
    estimated: false,
    currency: "INR",
    rateRuleId: Number(rate.rateRuleId),
    actualWeightKg: input.weightKg,
    volumetricWeightKg: round(volumetricWeight),
    chargeableWeightKg: round(chargeableWeight),
    baseCharge: round(base),
    weightCharge: round(weightCharge),
    serviceCharge: round(service),
    minimumAdjustment: round(minimumAdjustment),
    taxAmount: round(tax),
    total: round(taxable + tax),
    methods,
    payers,
    codEnabled: Boolean(settings.codEnabled),
  };
}

function verifyCollectionChoice(quote: Awaited<ReturnType<typeof getCustomerShippingQuote>>, payer: "SENDER" | "RECEIVER", method?: "DEMO_UPI" | "PAY_AT_PICKUP" | "PAY_AT_DELIVERY") {
  if (!quote.available) {
    if (method) throw new CustomerPortalError("A collection option cannot be selected until a company rate is configured.", 409);
    return;
  }
  if (!method) throw new CustomerPortalError("Select how the shipping charge will be collected.", 400);
  if (!quote.payers[payer]) throw new CustomerPortalError(`Shipping charges cannot be assigned to the ${payer.toLowerCase()} under this company's policy.`, 400);
  if (!quote.methods[method]) throw new CustomerPortalError("The selected collection option is not enabled for this company.", 400);
  if (method === "PAY_AT_PICKUP" && payer !== "SENDER") throw new CustomerPortalError("Pay at Pickup requires the sender to be the payer.", 400);
  if (method === "PAY_AT_DELIVERY" && payer !== "RECEIVER") throw new CustomerPortalError("Pay at Delivery requires the receiver to be the payer.", 400);
}

export async function bookCustomerShipment(companyId: number, customerId: string, accountId: number, input: z.infer<typeof bookingSchema>) {
  return runCompanyDataTransaction(companyId,"shipment.changed",async(connection)=>{
    const [prior]=await connection.execute<RowDataPacket[]>(`SELECT booking_request_id AS bookingRequestId,status FROM customer_booking_requests WHERE customer_account_id=? AND idempotency_key=? FOR UPDATE`,[accountId,input.idempotencyKey]);
    if(prior[0]) return { bookingRequestId: Number(prior[0].bookingRequestId), status: String(prior[0].status) };
    const [customerRows]=await connection.execute<RowDataPacket[]>(`SELECT customer_id FROM customers WHERE company_id=? AND customer_id=? FOR UPDATE`,[companyId,customerId]);
    if(!customerRows.length) throw new CustomerPortalError("Customer account is unavailable.",403);
    const quote = await getCustomerShippingQuote(connection, companyId, input);
    verifyCollectionChoice(quote, input.chargePayer, input.collectionMethod);
    if (input.codAmount && (!quote.codEnabled)) throw new CustomerPortalError("Cash on Delivery is not enabled for this company.", 400);
    const paymentStatus = !quote.available ? "NOT_REQUIRED" : input.collectionMethod === "DEMO_UPI" ? "DEMO_PENDING" : "COLLECTION_DUE";
    await connection.execute(
      `INSERT INTO customer_booking_requests
        (customer_account_id,idempotency_key,status,origin_hub_id,destination_hub_id,mode,pieces,weight_kg,length_cm,width_cm,height_cm,
         sender_name,sender_phone,sender_address,sender_city,sender_state,sender_pincode,recipient_name,recipient_phone,recipient_address,recipient_city,recipient_state,recipient_pincode,
         quoted_base_charge,quoted_weight_charge,quoted_service_charge,quoted_tax_amount,quoted_total,quoted_minimum_adjustment,quoted_chargeable_weight_kg,quote_rule_id,charge_payer,collection_method,payment_status,cod_amount)
       VALUES (?,?,'PENDING_APPROVAL',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [accountId,input.idempotencyKey,input.originHubId,input.destinationHubId,input.mode,input.pieces,input.weightKg,input.lengthCm??null,input.widthCm??null,input.heightCm??null,
       input.sender.name,input.sender.phone,input.sender.address,input.sender.city,input.sender.state,input.sender.pincode,input.recipient.name,input.recipient.phone,input.recipient.address,input.recipient.city,input.recipient.state,input.recipient.pincode,
       quote.baseCharge??null,quote.weightCharge??null,quote.serviceCharge??null,quote.taxAmount??null,quote.total??null,quote.minimumAdjustment??null,quote.chargeableWeightKg??null,quote.rateRuleId??null,input.chargePayer,input.collectionMethod??null,paymentStatus,input.codAmount??null]);
    const [created]=await connection.execute<RowDataPacket[]>(`SELECT booking_request_id AS bookingRequestId,status FROM customer_booking_requests WHERE customer_account_id=? AND idempotency_key=?`,[accountId,input.idempotencyKey]);
    const bookingRequestId = Number(created[0]!.bookingRequestId);
    if (quote.available && input.collectionMethod) {
      await connection.execute(
        `INSERT INTO shipment_payments (company_id,customer_account_id,booking_request_id,amount,currency,payment_method,payment_mode,payment_status)
         VALUES (?,?,?,?, 'INR',?,?,?)`,
        [companyId,accountId,bookingRequestId,Number(quote.total),input.collectionMethod,input.collectionMethod==="DEMO_UPI"?"DEMO":"OFFLINE",paymentStatus],
      );
    }
    return { bookingRequestId, status: String(created[0]!.status), quote: quote.available ? quote : null, paymentStatus };
  },input.originHubId,customerId);
}

export async function completeDemoBookingPayment(connection: PoolConnection, companyId: number, customerId: string, accountId: number, bookingRequestId: number) {
  if (!config.demoPaymentsEnabled) throw new CustomerPortalError("Demo payments are disabled in this environment.", 403);
  const [requests] = await connection.execute<RowDataPacket[]>(
    `SELECT r.status,r.collection_method AS collectionMethod,r.quoted_total AS amount,a.customer_id AS customerId
       FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=?
      WHERE r.booking_request_id=? AND r.customer_account_id=? AND a.customer_id=? FOR UPDATE`,
    [companyId, bookingRequestId, accountId, customerId],
  );
  const request = requests[0];
  if (!request) throw new CustomerPortalError("Booking request was not found for this customer.", 404);
  if (!["PENDING_APPROVAL", "APPROVED"].includes(String(request.status))) throw new CustomerPortalError("Payment is unavailable for a rejected or inactive booking.", 409);
  if (request.collectionMethod !== "DEMO_UPI" || request.amount === null) throw new CustomerPortalError("This booking does not have an online demo payment due.", 409);
  const [settings] = await connection.execute<RowDataPacket[]>("SELECT demo_upi_enabled AS enabled FROM company_payment_settings WHERE company_id=? LIMIT 1", [companyId]);
  if (!settings[0]?.enabled) throw new CustomerPortalError("Demo UPI is not enabled for this company.", 403);
  const [payments] = await connection.execute<RowDataPacket[]>(
    `SELECT payment_id AS paymentId,payment_status AS paymentStatus,transaction_reference AS transactionReference,amount,completed_at AS completedAt
       FROM shipment_payments WHERE company_id=? AND customer_account_id=? AND booking_request_id=? FOR UPDATE`,
    [companyId, accountId, bookingRequestId],
  );
  const payment = payments[0];
  if (!payment) throw new CustomerPortalError("Payment record was not found for this booking.", 409);
  if (payment.paymentStatus === "DEMO_PAID") return { bookingRequestId, amount: Number(payment.amount), currency: "INR", status: "DEMO_PAID", transactionReference: payment.transactionReference, completedAt: payment.completedAt };
  if (payment.paymentStatus !== "DEMO_PENDING") throw new CustomerPortalError("This demo payment is not awaiting completion.", 409);
  const reference = `DEMO-TXN-${randomBytes(9).toString("hex").toUpperCase()}`;
  await connection.execute("UPDATE shipment_payments SET payment_status='DEMO_PAID',transaction_reference=?,completed_at=CURRENT_TIMESTAMP() WHERE payment_id=? AND company_id=? AND payment_status='DEMO_PENDING'", [reference, payment.paymentId, companyId]);
  await connection.execute("UPDATE customer_booking_requests SET payment_status='DEMO_PAID' WHERE booking_request_id=? AND status IN ('PENDING_APPROVAL','APPROVED')", [bookingRequestId]);
  const [completed] = await connection.execute<RowDataPacket[]>("SELECT completed_at AS completedAt FROM shipment_payments WHERE payment_id=? AND company_id=?", [payment.paymentId, companyId]);
  return { bookingRequestId, amount: Number(payment.amount), currency: "INR", status: "DEMO_PAID", transactionReference: reference, completedAt: completed[0]?.completedAt ?? null };
}
export class CustomerPortalError extends Error { constructor(message:string,readonly statusCode:number){super(message);} }

export async function listCustomerBookingRequests(companyId:number,customerId:string){
 const [rows]=await pool.execute<RowDataPacket[]>(`SELECT r.booking_request_id AS bookingRequestId,r.status,r.origin_hub_id AS originHubId,r.destination_hub_id AS destinationHubId,r.mode,r.created_at AS requestedAt,r.rejection_reason AS rejectionReason,r.consignment_no AS consignmentNo,r.quoted_base_charge AS baseCharge,r.quoted_weight_charge AS weightCharge,r.quoted_service_charge AS serviceCharge,r.quoted_tax_amount AS taxAmount,r.quoted_minimum_adjustment AS minimumAdjustment,r.quoted_total AS totalCharge,r.charge_payer AS chargePayer,r.collection_method AS collectionMethod,r.payment_status AS paymentStatus,p.transaction_reference AS transactionReference,p.completed_at AS paymentCompletedAt,sc.collectionAmount,sc.collectionChannels,sc.collectionCompletedAt FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=? AND a.customer_id=? LEFT JOIN shipment_payments p ON p.company_id=a.company_id AND p.customer_account_id=a.customer_account_id AND p.booking_request_id=r.booking_request_id LEFT JOIN (SELECT company_id,consignment_no,SUM(amount) AS collectionAmount,GROUP_CONCAT(DISTINCT CONCAT(collection_method," · ",collection_channel) SEPARATOR ", ") AS collectionChannels,MAX(recorded_at) AS collectionCompletedAt FROM shipment_collections WHERE collection_status="COLLECTED" GROUP BY company_id,consignment_no) sc ON sc.company_id=a.company_id AND sc.consignment_no=r.consignment_no WHERE r.status IN ('PENDING_APPROVAL','REJECTED','APPROVED') ORDER BY r.created_at DESC,r.booking_request_id DESC LIMIT 100`,[companyId,customerId]);
 return rows;
}

export async function listOperationsBookingRequests(executor:Pool|PoolConnection,companyId:number,hubIds:string[]){
 if(!hubIds.length)return [];
 const [rows]=await executor.execute<RowDataPacket[]>(`SELECT r.booking_request_id AS bookingRequestId,c.customer_name AS customerName,r.created_at AS requestedAt,r.origin_hub_id AS originHubId,oh.city AS originCity,r.destination_hub_id AS destinationHubId,dh.city AS destinationCity,r.mode,r.pieces,r.weight_kg AS weightKg,r.sender_name AS senderName,r.sender_phone AS senderPhone,r.sender_address AS senderAddress,r.sender_city AS senderCity,r.sender_state AS senderState,r.sender_pincode AS senderPincode,r.recipient_name AS recipientName,r.recipient_phone AS recipientPhone,r.recipient_address AS recipientAddress,r.recipient_city AS recipientCity,r.recipient_state AS recipientState,r.recipient_pincode AS recipientPincode,r.quoted_base_charge AS baseCharge,r.quoted_weight_charge AS weightCharge,r.quoted_service_charge AS serviceCharge,r.quoted_tax_amount AS taxAmount,r.quoted_minimum_adjustment AS minimumAdjustment,r.quoted_total AS totalCharge,r.charge_payer AS chargePayer,r.collection_method AS collectionMethod,r.payment_status AS paymentStatus,p.payment_mode AS paymentMode,p.transaction_reference AS transactionReference FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=? JOIN customers c ON c.customer_id=a.customer_id AND c.company_id=a.company_id JOIN hubs oh ON oh.hub_id=r.origin_hub_id AND oh.company_id=a.company_id JOIN hubs dh ON dh.hub_id=r.destination_hub_id AND dh.company_id=a.company_id LEFT JOIN shipment_payments p ON p.company_id=a.company_id AND p.customer_account_id=a.customer_account_id AND p.booking_request_id=r.booking_request_id WHERE r.status='PENDING_APPROVAL' AND r.origin_hub_id IN (${hubIds.map(()=>"?").join(",")}) ORDER BY r.created_at,r.booking_request_id LIMIT 200`,[companyId,...hubIds]);
 return rows;
}

export async function getBookingRequestScope(executor:Pool|PoolConnection,companyId:number,bookingRequestId:number){
 const [rows]=await executor.execute<RowDataPacket[]>(`SELECT r.origin_hub_id AS originHubId,a.customer_id AS customerId FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=? WHERE r.booking_request_id=? LIMIT 1`,[companyId,bookingRequestId]);
 return rows[0]??null;
}

export async function approveCustomerBooking(connection:PoolConnection,companyId:number,employeeId:string,bookingRequestId:number,allowedHubIds:string[]){
 const [rows]=await connection.execute<RowDataPacket[]>(`SELECT r.*,a.customer_id AS customerId FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=? WHERE r.booking_request_id=? FOR UPDATE`,[companyId,bookingRequestId]);
 const request=rows[0]; if(!request)throw new CustomerPortalError("Booking request was not found in your company.",404);
 if(!allowedHubIds.includes(String(request.origin_hub_id)))throw new CustomerPortalError("You are not authorized to approve work for this origin hub.",403);
 if(request.status==="APPROVED"&&request.consignment_no)return getBooking(connection,companyId,String(request.customerId),String(request.consignment_no));
 if(request.status!=="PENDING_APPROVAL")throw new CustomerPortalError("Only pending booking requests can be approved.",409);
 const [routeRows]=await connection.execute<RowDataPacket[]>(`SELECT route_id AS routeId,mode,estimated_transit_days AS transitDays FROM routes r JOIN hubs o ON o.hub_id=r.origin_hub_id AND o.company_id=r.company_id JOIN hubs d ON d.hub_id=r.destination_hub_id AND d.company_id=r.company_id WHERE r.company_id=? AND UPPER(o.status)='ACTIVE' AND UPPER(d.status)='ACTIVE' AND r.origin_hub_id=? AND r.destination_hub_id=? AND LOWER(r.mode)=LOWER(?) LIMIT 1`,[companyId,request.origin_hub_id,request.destination_hub_id,request.mode]);
 const route=routeRows[0]; if(!route)throw new CustomerPortalError("The configured route is no longer active; request cannot be approved.",409);
 const consignmentNo=`LX${Date.now().toString(36).toUpperCase()}${randomBytes(8).toString("hex").toUpperCase()}`;
 const etaDays=route.transitDays==null?null:Number(route.transitDays); const eta=etaDays===null?null:new Date(Date.now()+etaDays*86400000);
 const quotedTotal=request.quoted_total==null?null:Number(request.quoted_total);
 const chargeableWeight=request.quoted_chargeable_weight_kg==null?Number(request.weight_kg):Number(request.quoted_chargeable_weight_kg);
 await connection.execute(`INSERT INTO shipments (consignment_no,company_id,customer_id,origin_hub_id,destination_hub_id,route_id,shipment_date,sender_name,sender_phone,sender_address,sender_city,sender_state,sender_pincode,recipient_name,recipient_phone,recipient_address,recipient_city,receiver_state,receiver_pincode,total_pieces,actual_weight,chargeable_weight,tariff,vas_charges,total_amount,mode,mode_of_payment,nature_of_consignment,estimated_transit_days,estimated_delivery_date,delivery_status,cod_amount) VALUES (?,?,?,?,?,?,CURRENT_DATE(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Parcel',?,?,'Booked',?)`,[consignmentNo,companyId,request.customerId,request.origin_hub_id,request.destination_hub_id,route.routeId,request.sender_name,request.sender_phone,request.sender_address,request.sender_city,request.sender_state,request.sender_pincode,request.recipient_name,request.recipient_phone,request.recipient_address,request.recipient_city,request.recipient_state,request.recipient_pincode,request.pieces,request.weight_kg,chargeableWeight,request.quoted_base_charge??null,Number(request.quoted_weight_charge??0)+Number(request.quoted_service_charge??0)+Number(request.quoted_minimum_adjustment??0),quotedTotal,route.mode,request.collection_method??'To be confirmed',etaDays,eta,request.cod_amount??null]);
 await connection.execute(`INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes) VALUES (?,CURRENT_TIMESTAMP(),'BOOKED','Booked',?,?,'Operations approved customer booking')`,[consignmentNo,request.origin_hub_id,employeeId]);
 await connection.execute(`UPDATE customer_booking_requests SET status='APPROVED',consignment_no=?,reviewed_by_employee_id=?,reviewed_at=CURRENT_TIMESTAMP() WHERE booking_request_id=? AND status='PENDING_APPROVAL'`,[consignmentNo,employeeId,bookingRequestId]);
 return getBooking(connection,companyId,String(request.customerId),consignmentNo);
}

export async function rejectCustomerBooking(connection:PoolConnection,companyId:number,employeeId:string,bookingRequestId:number,allowedHubIds:string[],reason:string){
 const [rows]=await connection.execute<RowDataPacket[]>(`SELECT r.status,r.origin_hub_id AS originHubId,a.customer_id AS customerId FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=? WHERE r.booking_request_id=? FOR UPDATE`,[companyId,bookingRequestId]);
 const row=rows[0]; if(!row)throw new CustomerPortalError("Booking request was not found in your company.",404);
 if(!allowedHubIds.includes(String(row.originHubId)))throw new CustomerPortalError("You are not authorized to reject work for this origin hub.",403);
 if(row.status!=="PENDING_APPROVAL")throw new CustomerPortalError("Only pending booking requests can be rejected.",409);
 await connection.execute(`UPDATE customer_booking_requests SET status='REJECTED',rejection_reason=?,reviewed_by_employee_id=?,reviewed_at=CURRENT_TIMESTAMP() WHERE booking_request_id=? AND status='PENDING_APPROVAL'`,[reason,employeeId,bookingRequestId]);
 return {bookingRequestId,status:"REJECTED",customerId:String(row.customerId)};
}
async function getBooking(executor:Pool|PoolConnection,companyId:number,customerId:string,consignmentNo:string){
 const [rows]=await executor.execute<RowDataPacket[]>(`SELECT s.consignment_no AS consignmentNo,COALESCE((SELECT NULLIF(se.event_type,'') FROM shipment_events se WHERE se.consignment_no=s.consignment_no ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1),s.delivery_status) AS status,s.origin_hub_id AS originHubId,s.destination_hub_id AS destinationHubId,s.mode,s.total_pieces AS pieces,s.actual_weight AS weightKg,s.total_amount AS totalAmount,s.estimated_delivery_date AS estimatedDeliveryAt FROM shipments s WHERE s.company_id=? AND s.customer_id=? AND s.consignment_no=? LIMIT 1`,[companyId,customerId,consignmentNo]);
 const row=rows[0]; if(!row) throw new CustomerPortalError("Booked shipment was not found.",404);
 return {...row,quote:{amount:row.totalAmount,label:row.totalAmount===null?"Price to be confirmed by operations":"Booked price"},estimatedDeliveryAt:row.estimatedDeliveryAt?new Date(row.estimatedDeliveryAt).toISOString():null};
}
export type CustomerShipmentQuery = { search?: string; page?: number; pageSize?: number; status?: "all" | "delivered" | "in_transit" | "exception"; sort?: "newest" | "oldest" };
const customerCurrentStatusSql = "(SELECT NULLIF(se.event_type,'') FROM shipment_events se WHERE se.consignment_no=s.consignment_no AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1 ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1)";
export async function listCustomerShipments(companyId:number,customerId:string,query:CustomerShipmentQuery={}){
 const search=(query.search??"").trim().slice(0,50); const page=Math.max(1,Math.floor(query.page??1)); const pageSize=Math.min(50,Math.max(1,Math.floor(query.pageSize??10))); const offset=(page-1)*pageSize;
 const conditions=["s.company_id=?","s.customer_id=?"]; const values: Array<string|number>=[companyId,customerId];
 if(search){conditions.push("s.consignment_no LIKE ?");values.push(`%${search}%`);}
 if(query.status==="delivered"){conditions.push(`${customerCurrentStatusSql}='DELIVERED'`);}
 if(query.status==="in_transit"){conditions.push(`${customerCurrentStatusSql} IN ('PICKED_UP','ARRIVED_AT_ORIGIN_HUB','RECEIVED_AT_ORIGIN_HUB','ASSIGNED_TO_TRANSPORT','LOADED_ON_TRANSPORT','DISPATCHED','ARRIVED_AT_HUB','RECEIVED_AT_HUB','RECEIVED_AT_DESTINATION_HUB','ARRIVED_AT_DESTINATION_HUB','OUT_FOR_DELIVERY')`);}
 if(query.status==="exception"){conditions.push(`${customerCurrentStatusSql} IN ('PICKUP_EXCEPTION','DELIVERY_EXCEPTION','TRANSPORT_MISSING_EXCEPTION','TRANSPORT_DAMAGED_EXCEPTION')`);}
 const where=conditions.join(" AND ");
 const [countRows]=await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM shipments s WHERE ${where}`,values);
 const total=Number(countRows[0]?.total??0); const order=query.sort==="oldest"?"ASC":"DESC";
 const [rows]=await pool.execute<RowDataPacket[]>(`SELECT s.consignment_no AS consignmentNo,s.shipment_date AS shipmentDate,${customerCurrentStatusSql} AS status,s.delivery_status AS recordedOutcome,s.origin_hub_id AS originHubId,s.destination_hub_id AS destinationHubId,s.mode,s.total_pieces AS pieces,s.actual_weight AS weightKg,s.total_amount AS totalAmount,s.estimated_delivery_date AS estimatedDeliveryAt FROM shipments s WHERE ${where} ORDER BY s.shipment_date ${order},s.consignment_no ${order} LIMIT ? OFFSET ?`,[...values,pageSize,offset]);
 return {shipments:rows.map(row=>({...row,quote:{amount:row.totalAmount,label:row.totalAmount===null?"Price to be confirmed":"Booked price"},estimatedDeliveryAt:row.estimatedDeliveryAt?new Date(row.estimatedDeliveryAt).toISOString():null})),pagination:{page,pageSize,total,totalPages:Math.ceil(total/pageSize)}};
}
export async function getCustomerShipmentSummary(companyId:number,customerId:string){
 const [rows]=await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total,COALESCE(SUM(${customerCurrentStatusSql}='DELIVERED'),0) AS delivered,COALESCE(SUM(${customerCurrentStatusSql} IN ('PICKED_UP','ARRIVED_AT_ORIGIN_HUB','RECEIVED_AT_ORIGIN_HUB','ASSIGNED_TO_TRANSPORT','LOADED_ON_TRANSPORT','DISPATCHED','ARRIVED_AT_HUB','RECEIVED_AT_HUB','RECEIVED_AT_DESTINATION_HUB','ARRIVED_AT_DESTINATION_HUB','OUT_FOR_DELIVERY')),0) AS inTransit,COALESCE(SUM(${customerCurrentStatusSql} IN ('PICKUP_EXCEPTION','DELIVERY_EXCEPTION','TRANSPORT_MISSING_EXCEPTION','TRANSPORT_DAMAGED_EXCEPTION')),0) AS exceptions,COALESCE(SUM(${customerCurrentStatusSql} IS NULL OR ${customerCurrentStatusSql}='BOOKED'),0) AS awaitingEvent FROM shipments s WHERE s.company_id=? AND s.customer_id=?`,[companyId,customerId]);
 const row=rows[0];return {total:Number(row?.total??0),delivered:Number(row?.delivered??0),inTransit:Number(row?.inTransit??0),exceptions:Number(row?.exceptions??0),awaitingEvent:Number(row?.awaitingEvent??0)};
}
export async function getCustomerShipment(companyId:number,customerId:string,consignmentNo:string){
  const [rows]=await pool.execute<RowDataPacket[]>(`SELECT s.consignment_no AS consignmentNo,s.shipment_date AS shipmentDate,${customerCurrentStatusSql} AS status,s.delivery_status AS recordedOutcome,s.origin_hub_id AS originHubId,s.destination_hub_id AS destinationHubId,oh.city AS originCity,oh.latitude AS originLatitude,oh.longitude AS originLongitude,dh.city AS destinationCity,dh.latitude AS destinationLatitude,dh.longitude AS destinationLongitude,s.mode,s.total_pieces AS pieces,s.actual_weight AS weightKg,s.sender_name AS senderName,s.sender_phone AS senderPhone,s.sender_address AS senderAddress,s.sender_city AS senderCity,s.sender_state AS senderState,s.sender_pincode AS senderPincode,s.recipient_name AS recipientName,s.recipient_phone AS recipientPhone,s.recipient_address AS recipientAddress,s.recipient_city AS recipientCity,s.receiver_state AS recipientState,s.receiver_pincode AS recipientPincode,s.total_amount AS totalAmount,s.estimated_delivery_date AS estimatedDeliveryAt FROM shipments s LEFT JOIN hubs oh ON oh.company_id=s.company_id AND oh.hub_id=s.origin_hub_id LEFT JOIN hubs dh ON dh.company_id=s.company_id AND dh.hub_id=s.destination_hub_id WHERE s.company_id=? AND s.customer_id=? AND s.consignment_no=? LIMIT 1`,[companyId,customerId,consignmentNo]);
 if(!rows[0])throw new CustomerPortalError("Shipment was not found.",404);
  const [events]=await pool.execute<RowDataPacket[]>(`SELECT se.event_time AS eventTime,se.event_type AS eventType,se.event_status AS status,se.hub_id AS hubId,h.city AS hubCity,h.latitude AS hubLatitude,h.longitude AS hubLongitude,se.notes FROM shipment_events se JOIN shipments s ON s.consignment_no=se.consignment_no LEFT JOIN hubs h ON h.hub_id=se.hub_id AND h.company_id=s.company_id WHERE s.company_id=? AND s.customer_id=? AND s.consignment_no=? AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1 ORDER BY se.event_time,se.event_id`,[companyId,customerId,consignmentNo]);
 return {...rows[0],quote:{amount:rows[0]!.totalAmount,label:rows[0]!.totalAmount===null?"Price to be confirmed":"Booked price"},estimatedDeliveryAt:rows[0]!.estimatedDeliveryAt?new Date(rows[0]!.estimatedDeliveryAt).toISOString():null,events};
}
export async function getCustomerShippingLabel(companyId:number,customerId:string,consignmentNo:string){
 const [rows]=await pool.execute<RowDataPacket[]>(`SELECT s.consignment_no AS consignmentNo,s.shipment_date AS bookingDate,s.mode,s.actual_weight AS weightKg,s.chargeable_weight AS chargeableWeightKg,s.total_amount AS shippingCharge,s.cod_amount AS codAmount,s.mode_of_payment AS collectionMethod,r.charge_payer AS chargePayer,r.payment_status AS paymentStatus,r.collection_method AS bookingCollectionMethod,c.company_name AS companyName,oh.hub_id AS originHubId,oh.city AS originCity,dh.hub_id AS destinationHubId,dh.city AS destinationCity,s.sender_name AS senderName,s.sender_phone AS senderPhone,s.sender_address AS senderAddress,s.sender_city AS senderCity,s.sender_state AS senderState,s.sender_pincode AS senderPincode,s.recipient_name AS recipientName,s.recipient_phone AS recipientPhone,s.recipient_address AS recipientAddress,s.recipient_city AS recipientCity,s.receiver_state AS recipientState,s.receiver_pincode AS recipientPincode FROM shipments s JOIN customer_booking_requests r ON r.consignment_no=s.consignment_no AND r.status='APPROVED' JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=s.company_id AND a.customer_id=s.customer_id JOIN companies c ON c.company_id=s.company_id JOIN hubs oh ON oh.hub_id=s.origin_hub_id AND oh.company_id=s.company_id JOIN hubs dh ON dh.hub_id=s.destination_hub_id AND dh.company_id=s.company_id WHERE s.company_id=? AND s.customer_id=? AND s.consignment_no=? LIMIT 1`,[companyId,customerId,consignmentNo]);
 if(!rows[0])throw new CustomerPortalError("An approved shipping label was not found for this customer shipment.",404);
 return {...rows[0],branding:brandingForCompany(companyId),qrPayload:`LOGIX-SHIPMENT:${consignmentNo}`};
}
export const customerSchemas={credentialsSchema,registerSchema,bookingSchema,quoteRequestSchema};
export function customerLoginSession(response:Response,customer:AuthCustomer){setCustomerCookie(response,customer.accountId,customer.companyId);return {customer:{id:customer.customerId,email:customer.email,name:customer.name}};}
export function customerFromRequest(request:Request){return request.customer!;}
export function customerCompanyId(){return config.customerPortalCompanyId;}
export { pool as customerPool };

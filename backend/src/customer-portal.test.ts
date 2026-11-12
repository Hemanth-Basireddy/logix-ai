import assert from "node:assert/strict";
import test from "node:test";
import { approveCustomerBooking, CustomerPortalError, customerSchemas, getCustomerShippingQuote, rejectCustomerBooking } from "./customer-portal.js";
import { customerPhoneKey, toOtpE164 } from "./customer-phone.js";
import { createTwilioVerifyProvider, OtpProviderUnavailableError } from "./customer-otp.js";

test("customer registration normalizes email and validates profile and password", () => {
  const parsed = customerSchemas.registerSchema.safeParse({
    email: "  Synthetic.Customer@example.invalid ",
    password: "Synthetic-Customer-41!",
    confirmPassword: "Synthetic-Customer-41!",
    name: "Synthetic Customer",
    phone: "+91 9000000001",
    address: "1 Test Street",
    city: "Test City",
    state: "Test State",
    pincode: "123456",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.email, "synthetic.customer@example.invalid");

  assert.equal(customerSchemas.registerSchema.safeParse({
    email: "bad-email",
    password: "short",
    name: "A",
    phone: "not a phone",
    address: "x",
    city: "x",
    state: "x",
    pincode: "12",
  }).success, false);
});

test("customer sign-in accepts a phone or email and password", () => {
  assert.equal(customerSchemas.credentialsSchema.safeParse({ identifier: "person@example.invalid", password: "A-long-password-123" }).success, true);
  assert.equal(customerSchemas.credentialsSchema.safeParse({ identifier: "919876543210", password: "Ravi Sharma" }).success, true);
  assert.equal(customerSchemas.credentialsSchema.safeParse({ identifier: "919876543210", password: "" }).success, false);
});

test("customer bookings validate route choice, tracking idempotency key, contacts, and weight", () => {
  const valid = {
    idempotencyKey: "53ea948e-d1bf-46c4-9a62-5eb6f19e8581",
    originHubId: "ORIGIN",
    destinationHubId: "DESTINATION",
    mode: "Surface",
    pieces: 1,
    weightKg: 1.25,
    chargePayer: "SENDER" as const,
    sender: { name: "Sender Name", phone: "+91 9000000001", address: "1 Origin Street", city: "Origin City", state: "Test State", pincode: "123456" },
    recipient: { name: "Receiver Name", phone: "+91 9000000002", address: "2 Destination Street", city: "Destination City", state: "Test State", pincode: "654321" },
  };
  assert.equal(customerSchemas.bookingSchema.safeParse(valid).success, true);
  assert.equal(customerSchemas.bookingSchema.safeParse({ ...valid, weightKg: 0 }).success, false);
  assert.equal(customerSchemas.bookingSchema.safeParse({ ...valid, companyId: 99 }).success, false);
  assert.equal(customerSchemas.bookingSchema.safeParse({ ...valid, destinationHubId: "ORIGIN" }).success, false);
});

test("shipping quote uses persisted route rules, volumetric weight, minimum charge, and tenant payment settings", async () => {
  const results:unknown[]=[[{route:1}],[{rateRuleId:8,baseCharge:"50.00",includedWeightKg:"1.000",perKgCharge:"5.00",serviceCharge:"0.00",minimumCharge:"200.00",taxRatePercent:"10.0000",volumetricDivisor:null}],[{senderPaysEnabled:0,receiverPaysEnabled:1,demoUpiEnabled:1,payAtPickupEnabled:1,payAtDeliveryEnabled:0,codEnabled:1}]];
  const executor={execute:async<T>(sql:string,values?:unknown)=>{void sql;void values;return [results.shift(),[]] as unknown as T;}} as unknown as import("mysql2/promise").PoolConnection;
  const quote=await getCustomerShippingQuote(executor,7,{originHubId:"H1",destinationHubId:"H2",mode:"Surface",weightKg:1});
  assert.equal(quote.available,true);
  if(!quote.available)return;
  assert.equal(quote.minimumAdjustment,150);
  assert.equal(quote.taxAmount,20);
  assert.equal(quote.total,220);
  assert.deepEqual(quote.payers,{SENDER:false,RECEIVER:true});
  assert.equal(quote.methods.DEMO_UPI,true);
  assert.equal(quote.methods.PAY_AT_PICKUP,true);
  assert.equal(quote.methods.PAY_AT_DELIVERY,false);
  assert.equal(quote.codEnabled,true);
});

function approvalConnection(results: unknown[]) {
  const calls: Array<{ sql: string; values: unknown }> = [];
  const connection = {
    execute: async <T>(sql: string, values?: unknown) => { calls.push({ sql: sql.replace(/\s+/g," ").trim(), values }); return [results.shift(), []] as unknown as T; },
  } as unknown as import("mysql2/promise").PoolConnection;
  return { connection, calls };
}

test("Operations approval creates the active shipment and BOOKED event only from a pending request", async () => {
  const { connection, calls } = approvalConnection([
    [{ status: "PENDING_APPROVAL", origin_hub_id: "HUB-1", destination_hub_id: "HUB-2", customerId: "CUSTOMER-1", mode: "Surface", pieces: 1, weight_kg: 2, quoted_base_charge: "120.00", quoted_weight_charge: "20.00", quoted_service_charge: "15.00", quoted_tax_amount: "27.90", quoted_total: "182.90", quoted_chargeable_weight_kg: "3.000", collection_method: "PAY_AT_PICKUP", cod_amount: "0.00", sender_name: "Sender", sender_phone: "9000000001", sender_address: "Origin street", sender_city: "Origin", sender_state: "State", sender_pincode: "123456", recipient_name: "Recipient", recipient_phone: "9000000002", recipient_address: "Destination street", recipient_city: "Destination", recipient_state: "State", recipient_pincode: "654321" }],
    [{ routeId: "ROUTE-1", mode: "Surface", transitDays: 2 }],
    { affectedRows: 1 }, { affectedRows: 1 }, { affectedRows: 1 },
    [{ consignmentNo: "LXAPPROVED", status: "BOOKED", originHubId: "HUB-1", destinationHubId: "HUB-2", mode: "Surface", pieces: 1, weightKg: 2, totalAmount: null, estimatedDeliveryAt: null }],
  ]);
  const shipment = await approveCustomerBooking(connection, 1, "OPS-1", 5, ["HUB-1"]);
  assert.equal((shipment as unknown as {consignmentNo:string}).consignmentNo.startsWith("LX"), true);
  assert.match(calls[2]!.sql, /INSERT INTO shipments/);
  assert.match(calls[2]!.sql, /chargeable_weight,tariff,vas_charges,total_amount,mode,mode_of_payment/);
  assert.equal((calls[2]!.values as unknown[])[20], 3);
  assert.equal((calls[2]!.values as unknown[])[21], "120.00");
  assert.equal((calls[2]!.values as unknown[])[23], 182.9);
  assert.equal((calls[2]!.values as unknown[])[25], "PAY_AT_PICKUP");
  assert.match(calls[3]!.sql, /INSERT INTO shipment_events/);
  assert.match(calls[4]!.sql, /SET status='APPROVED',consignment_no=\?/);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO shipments")).length, 1);
});

test("repeated approval returns the existing shipment and cannot create a duplicate", async () => {
  const { connection, calls } = approvalConnection([
    [{ status: "APPROVED", origin_hub_id: "HUB-1", customerId: "CUSTOMER-1", consignment_no: "LX-ONE" }],
    [{ consignmentNo: "LX-ONE", status: "BOOKED", originHubId: "HUB-1", destinationHubId: "HUB-2", mode: "Surface", pieces: 1, weightKg: 1, totalAmount: null, estimatedDeliveryAt: null }],
  ]);
  const shipment = await approveCustomerBooking(connection, 1, "OPS-1", 5, ["HUB-1"]);
  assert.equal((shipment as unknown as {consignmentNo:string}).consignmentNo, "LX-ONE");
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO shipments")), false);
});

test("Operations approval rejects a request outside its assigned origin hub", async () => {
  const { connection, calls } = approvalConnection([
    [{ status: "PENDING_APPROVAL", origin_hub_id: "HUB-OTHER", customerId: "CUSTOMER-1" }],
  ]);
  await assert.rejects(approveCustomerBooking(connection, 1, "OPS-1", 5, ["HUB-1"]), (error: unknown) => error instanceof CustomerPortalError && error.statusCode === 403);
  assert.equal(calls.length, 1);
});

test("Operations rejection persists its reason for the scoped customer request", async () => {
  const { connection, calls } = approvalConnection([
    [{ status: "PENDING_APPROVAL", originHubId: "HUB-1", customerId: "CUSTOMER-1" }],
    { affectedRows: 1 },
  ]);
  const result = await rejectCustomerBooking(connection, 1, "OPS-1", 5, ["HUB-1"], "Address details need correction");
  assert.deepEqual(result, { bookingRequestId: 5, status: "REJECTED", customerId: "CUSTOMER-1" });
  assert.match(calls[1]!.sql, /SET status='REJECTED',rejection_reason=\?/);
  assert.deepEqual(calls[1]!.values, ["Address details need correction", "OPS-1", 5]);
});

test("phone normalization strips formatting without dropping digits or inferring country codes", () => {
  assert.equal(customerPhoneKey(" +91 (9876) 543-210 "), "919876543210");
  assert.equal(customerPhoneKey("09876 543210"), "09876543210");
  assert.notEqual(customerPhoneKey("+919876543210"), customerPhoneKey("9876543210"));
  assert.equal(toOtpE164("(9876) 543-210", ""), null);
  assert.equal(toOtpE164("(9876) 543-210", "+91"), "+919876543210");
  assert.equal(toOtpE164("+44 20 7946 0958", "+91"), "+442079460958");
  assert.equal(customerPhoneKey("12345"), customerPhoneKey("12 345"));
  assert.notEqual(customerPhoneKey("12345"), customerPhoneKey("9912345"));
});

test("Twilio Verify provider fails closed when credentials are incomplete", () => {
  assert.throws(() => createTwilioVerifyProvider({ accountSid: "", authToken: "", verifyServiceSid: "" }), OtpProviderUnavailableError);
});

test("Twilio Verify adapter sends SMS checks and accepts only approved verifications", async () => {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify({ status: requests.length === 2 ? "approved" : "pending" }), { status: 200 });
  };
  const provider = createTwilioVerifyProvider({ accountSid: "AC-test", authToken: "synthetic-secret", verifyServiceSid: "VA-test" }, fetcher);
  await provider.start("+919876543210");
  assert.equal(await provider.check("+919876543210", "123456"), true);
  assert.match(requests[0]!.url, /Verifications$/);
  assert.equal(requests[0]!.body.get("Channel"), "sms");
  assert.equal(requests[1]!.body.get("Code"), "123456");
  assert.match(requests[0]!.url, /verify\.twilio\.com/);
  const expiredProvider = createTwilioVerifyProvider({ accountSid: "AC-test", authToken: "synthetic-secret", verifyServiceSid: "VA-test" }, async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
  assert.equal(await expiredProvider.check("+919876543210", "000000"), false);
});

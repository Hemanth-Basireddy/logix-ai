import "dotenv/config";
import { z } from "zod";
import { mergeCompanyBranding, type CompanyBranding } from "./company-branding.js";
import { resolveDatabaseTarget } from "./database-target.js";

const brandingEntrySchema = z.object({
  logoPath: z
    .string()
    .regex(/^\/brands\/[A-Za-z0-9._/-]+$/)
    .refine((path) => !path.includes(".."))
    .optional(),
  accentColor: z.string().regex(/^#[\da-fA-F]{6}$/).optional(),
});

const brandingSchema = z.record(z.string(), brandingEntrySchema);
const defaultCompanyBranding: z.infer<typeof brandingSchema> = {
  "1": {
    logoPath: "/brands/dtdc-logo.png",
    accentColor: "#e31837",
  },
};

function loadBranding(): z.infer<typeof brandingSchema> {
  const raw = process.env.COMPANY_BRANDING_JSON ?? "{}";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("COMPANY_BRANDING_JSON must contain valid JSON.");
  }

  const result = brandingSchema.safeParse(value);
  if (!result.success) {
    throw new Error("COMPANY_BRANDING_JSON contains an invalid company branding entry.");
  }
  return result.data;
}

function requiredString(name: string, minimumLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must be set and contain at least ${minimumLength} characters.`);
  }
  return value;
}

const portValue = Number(process.env.PORT ?? "4000");
const database = resolveDatabaseTarget(process.env);
const nodeEnv = process.env.NODE_ENV ?? "development";
const demoPaymentsRaw = process.env.DEMO_PAYMENTS_ENABLED;
const demoPaymentsEnabled = demoPaymentsRaw === undefined ? nodeEnv !== "production" : demoPaymentsRaw === "true";
const customerCompanyRaw = process.env.CUSTOMER_PORTAL_COMPANY_ID;
const customerCompanyId = customerCompanyRaw === undefined ? null : Number(customerCompanyRaw);
const customerPortalMode = process.env.CUSTOMER_PORTAL_MODE ?? "public";
const customerOtpCountryCode = process.env.CUSTOMER_OTP_DEFAULT_COUNTRY_CODE ?? "";
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (customerCompanyId !== null && (!Number.isSafeInteger(customerCompanyId) || customerCompanyId < 1)) {
  throw new Error("CUSTOMER_PORTAL_COMPANY_ID must be a positive integer when configured.");
}
if (customerPortalMode !== "public" && customerPortalMode !== "demo") {
  throw new Error("CUSTOMER_PORTAL_MODE must be either public or demo.");
}
if (demoPaymentsRaw !== undefined && demoPaymentsRaw !== "true" && demoPaymentsRaw !== "false") {
  throw new Error("DEMO_PAYMENTS_ENABLED must be true or false when configured.");
}
if (customerOtpCountryCode && !/^\+[1-9]\d{0,3}$/.test(customerOtpCountryCode)) {
  throw new Error("CUSTOMER_OTP_DEFAULT_COUNTRY_CODE must be an international calling code such as +91.");
}

export const config = {
  nodeEnv,
  demoPaymentsEnabled,
  port: portValue,
  databaseMode: database.mode,
  customerPortalMode,
  customerPortalCompanyId: customerCompanyId,
  customerOtp: {
    accountSid: process.env.CUSTOMER_OTP_TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.CUSTOMER_OTP_TWILIO_AUTH_TOKEN ?? "",
    verifyServiceSid: process.env.CUSTOMER_OTP_TWILIO_VERIFY_SERVICE_SID ?? "",
    defaultCountryCode: customerOtpCountryCode,
  },
  jwtSecret: requiredString("JWT_SECRET", 32),
  database,
  companyBranding: mergeCompanyBranding(defaultCompanyBranding, loadBranding()),
};

export type { CompanyBranding } from "./company-branding.js";

export function brandingForCompany(companyId: number): CompanyBranding {
  return config.companyBranding[String(companyId)] ?? {};
}

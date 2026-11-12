import assert from "node:assert/strict";
import test from "node:test";
import { mergeCompanyBranding } from "./company-branding.js";
import { isArgon2idHash, mapEmployeeRole } from "./employee-roles.js";
import { isValidResetPassword } from "./password-policy.js";
import {
  exceededShipmentSla,
  onTimeDeliveryRate,
  parseIsoDate,
  previousEquivalentPeriod,
  trendGranularityForRange,
} from "./dashboard-domain.js";

test("maps the existing ADMIN database role to the company-admin workspace", () => {
  assert.equal(mapEmployeeRole("ADMIN"), "COMPANY_ADMIN");
  assert.equal(mapEmployeeRole("company_admin"), "COMPANY_ADMIN");
});

test("preserves operational role names and rejects unrecognized roles", () => {
  assert.equal(mapEmployeeRole("OPERATIONS_MANAGER"), "OPERATIONS_MANAGER");
  assert.equal(mapEmployeeRole("HUB_MANAGER"), "HUB_MANAGER");
  assert.equal(mapEmployeeRole("LOGISTICS_EXECUTIVE"), "LOGISTICS_EXECUTIVE");
  assert.equal(mapEmployeeRole("SUPER_ADMIN"), null);
});

test("recognizes Argon2id hashes without accepting plaintext values", () => {
  assert.equal(isArgon2idHash("$argon2id$v=19$m=19456,t=2,p=1$test$salt"), true);
  assert.equal(isArgon2idHash("plaintext-value"), false);
  assert.equal(isArgon2idHash(null), false);
});

test("company branding overrides preserve unspecified default fields", () => {
  assert.deepEqual(
    mergeCompanyBranding(
      { "1": { logoPath: "/brands/dtdc-logo.png", accentColor: "#e31837" } },
      { "1": { accentColor: "#008000" }, "2": { logoPath: "/brands/other.png" } },
    ),
    {
      "1": { logoPath: "/brands/dtdc-logo.png", accentColor: "#008000" },
      "2": { logoPath: "/brands/other.png" },
    },
  );
});

test("reset password policy requires 12 through 1024 characters", () => {
  assert.equal(isValidResetPassword("ShortPass1!"), false);
  assert.equal(isValidResetPassword("ValidPassword1!"), true);
  assert.equal(isValidResetPassword("a".repeat(1024)), true);
  assert.equal(isValidResetPassword("a".repeat(1025)), false);
});

test("shipment delay uses recorded SLA and the explicitly non-policy four-day fallback", () => {
  assert.equal(
    exceededShipmentSla({ deliveryStatus: "Delayed", actualTransitDays: 5, slaDays: 4 }),
    true,
  );
  assert.equal(
    exceededShipmentSla({ deliveryStatus: "On Time", actualTransitDays: 4, slaDays: null }),
    false,
  );
  assert.equal(
    exceededShipmentSla({ deliveryStatus: "In Transit", actualTransitDays: null, slaDays: 2 }),
    false,
  );
});

test("on-time delivery rate excludes an empty eligible-delivery denominator", () => {
  assert.equal(onTimeDeliveryRate(8, 10), 80);
  assert.equal(onTimeDeliveryRate(0, 0), null);
});

test("date filters validate calendar values and calculate equivalent prior periods", () => {
  assert.equal(parseIsoDate("2025-02-28", "startDate"), "2025-02-28");
  assert.equal(parseIsoDate("", "startDate"), null);
  assert.equal(parseIsoDate(undefined, "startDate"), null);
  assert.throws(() => parseIsoDate("2025-02-30", "startDate"));
  assert.deepEqual(previousEquivalentPeriod("2025-06-10", "2025-06-19"), {
    startDate: "2025-05-31",
    endDate: "2025-06-09",
  });

  test("dashboard trend resolution uses daily data for focused ranges and weekly for long history", () => {
    assert.equal(trendGranularityForRange("2025-06-06", "2025-07-05"), "day");
    assert.equal(trendGranularityForRange("2025-01-01", "2025-12-31"), "week");
    assert.equal(trendGranularityForRange(null, "2025-12-31"), "week");
  });
  assert.throws(() => previousEquivalentPeriod("2025-06-20", "2025-06-19"));
});

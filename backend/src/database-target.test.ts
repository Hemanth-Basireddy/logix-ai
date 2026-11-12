import assert from "node:assert/strict";
import test from "node:test";
import { resolveDatabaseTarget } from "./database-target.js";

test("test database mode requires dedicated credentials and never falls back to application settings", () => {
  assert.throws(() => resolveDatabaseTarget({
    LOGIX_DB_MODE: "test",
    DB_HOST: "127.0.0.1",
    DB_PORT: "3306",
    DB_NAME: "logistics_db",
    DB_USER: "app-user",
    DB_PASSWORD: "app-password",
  }), /LOGIX_TEST_DB_(?:HOST|PORT|NAME|USER|PASSWORD) must be set/);
});

test("test database mode rejects protected and non-disposable database names", () => {
  const base = { LOGIX_DB_MODE: "test", LOGIX_TEST_DB_HOST: "127.0.0.1", LOGIX_TEST_DB_PORT: "3306", LOGIX_TEST_DB_USER: "test", LOGIX_TEST_DB_PASSWORD: "test" };
  assert.throws(() => resolveDatabaseTarget({ ...base, LOGIX_TEST_DB_NAME: "logistics_db" }), /protected database/);
  assert.throws(() => resolveDatabaseTarget({ ...base, LOGIX_TEST_DB_NAME: "roammate_db" }), /protected database/);
  assert.throws(() => resolveDatabaseTarget({ ...base, LOGIX_TEST_DB_NAME: "customer_test" }), /isolated logix_customer_test_/);
});

test("test database target uses only explicit test variables", () => {
  const target = resolveDatabaseTarget({
    LOGIX_DB_MODE: "test",
    LOGIX_TEST_DB_HOST: "db-test.local",
    LOGIX_TEST_DB_PORT: "3307",
    LOGIX_TEST_DB_NAME: "logix_customer_test_ci",
    LOGIX_TEST_DB_USER: "ci-user",
    LOGIX_TEST_DB_PASSWORD: "ci-password",
    DB_HOST: "production.local",
    DB_PORT: "3306",
    DB_NAME: "logistics_db",
    DB_USER: "production-user",
    DB_PASSWORD: "production-password",
  });
  assert.deepEqual(target, { mode: "test", host: "db-test.local", port: 3307, name: "logix_customer_test_ci", user: "ci-user", password: "ci-password" });
});

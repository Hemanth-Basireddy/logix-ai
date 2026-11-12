export type DatabaseEnvironment = Record<string, string | undefined>;
export type DatabaseTarget = {
  mode: "application" | "test";
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
};

function required(environment: DatabaseEnvironment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} must be set when LOGIX_DB_MODE=test.`);
  return value;
}

export function resolveDatabaseTarget(environment: DatabaseEnvironment): DatabaseTarget {
  const mode = environment.LOGIX_DB_MODE ?? "application";
  if (mode !== "application" && mode !== "test") throw new Error("LOGIX_DB_MODE must be either application or test.");

  const testMode = mode === "test";
  const portText = testMode ? required(environment, "LOGIX_TEST_DB_PORT") : (environment.DB_PORT ?? "3306");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${testMode ? "LOGIX_TEST_DB_PORT" : "DB_PORT"} must be a valid TCP port.`);

  const name = testMode ? required(environment, "LOGIX_TEST_DB_NAME") : (environment.DB_NAME ?? "logistics_db");
  if (testMode) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "logistics_db" || normalizedName === "roammate_db") {
      throw new Error("LOGIX_TEST_DB_NAME cannot target a protected database.");
    }
    if (!/^logix_customer_test_[a-z0-9_]+$/.test(normalizedName)) {
      throw new Error("LOGIX_TEST_DB_NAME must use the isolated logix_customer_test_ prefix.");
    }
  }

  return {
    mode,
    host: testMode ? required(environment, "LOGIX_TEST_DB_HOST") : (environment.DB_HOST ?? "127.0.0.1"),
    port,
    name,
    user: testMode ? required(environment, "LOGIX_TEST_DB_USER") : required(environment, "DB_USER"),
    password: testMode ? required(environment, "LOGIX_TEST_DB_PASSWORD") : required(environment, "DB_PASSWORD"),
  };
}

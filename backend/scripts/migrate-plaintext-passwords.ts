import "dotenv/config";
import argon2 from "argon2";
import { createInterface } from "node:readline/promises";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import mysql from "mysql2/promise";

const expectedDatabase = "logistics_db";
const expectedEmployeeCount = 118;
const plaintextPattern = /^[\x20-\x7e]{13}$/;
const hashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

type EmployeePasswordRow = RowDataPacket & {
  employee_id: string;
  password: string | null;
};

type DatabaseRow = RowDataPacket & {
  database_name: string | null;
};

type LoggingRow = RowDataPacket & {
  general_log: string | number;
  slow_query_log: string | number;
  log_output: string;
  log_bin: string;
  binlog_format: string;
  global_binlog_row_image: string;
  session_binlog_row_image: string;
  session_sql_log_bin?: string | number;
};

type MetadataCountRow = RowDataPacket & {
  total: number;
};

type Preflight = {
  rows: EmployeePasswordRow[];
  databaseVerified: boolean;
  employeeCountVerified: boolean;
  passwordsVerified: boolean;
  innodbVerified: boolean;
  employeePrimaryKeyVerified: boolean;
  noTriggersVerified: boolean;
  applicationLogChecksPassed: boolean;
  logging: LoggingRow;
};

function modeFromArgs(args: string[]): "preflight" | "migrate" {
  if (args.length === 1 && args[0] === "--preflight") return "preflight";
  if (args.length === 0) return "migrate";
  throw new Error("Use no arguments to migrate, or --preflight for read-only checks.");
}

function requireDatabaseSettings(): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = Number(process.env.DB_PORT ?? "3306");
  const database = process.env.DB_NAME ?? expectedDatabase;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Database configuration check failed.");
  }
  if (!user || password === undefined) {
    throw new Error("Database configuration check failed.");
  }
  if (database !== expectedDatabase) {
    throw new Error("Configured database is not the approved target; no changes were made.");
  }
  return { host, port, database, user, password };
}

function isEligiblePlaintext(value: string | null): value is string {
  return typeof value === "string" && plaintextPattern.test(value);
}

function isEnabled(value: string | number): boolean {
  const normalized = String(value).toUpperCase();
  return normalized === "1" || normalized === "ON";
}

function sameEmployeeSet(
  expectedRows: EmployeePasswordRow[],
  actualRows: EmployeePasswordRow[],
): boolean {
  if (expectedRows.length !== actualRows.length) return false;
  const expectedIds = new Set(expectedRows.map((row) => row.employee_id));
  return (
    expectedIds.size === expectedRows.length &&
    actualRows.every((row) => expectedIds.delete(row.employee_id)) &&
    expectedIds.size === 0
  );
}

function reportPreflight(result: Preflight): void {
  const checks: Array<[string, boolean]> = [
    ["Connected database is logistics_db", result.databaseVerified],
    [`Employee count is exactly ${expectedEmployeeCount}`, result.employeeCountVerified],
    [
      `All ${expectedEmployeeCount} passwords match the approved plaintext format`,
      result.passwordsVerified,
    ],
    ["employees table uses InnoDB", result.innodbVerified],
    ["employees.employee_id is the primary key", result.employeePrimaryKeyVerified],
    ["No employees-table triggers are installed", result.noTriggersVerified],
    ["MySQL general query log is disabled", result.applicationLogChecksPassed],
    ["Binary logging uses ROW format", result.logging.binlog_format.toUpperCase() === "ROW"],
    [
      "Global row image remains FULL; migration will use MINIMAL for its session only",
      result.logging.global_binlog_row_image.toUpperCase() === "FULL",
    ],
  ];

  console.log("Password migration preflight (read-only)");
  for (const [label, passed] of checks) {
    console.log(`${passed ? "PASS" : "FAIL"} ${label}`);
  }
  console.log(
    `SAFE COUNTS: employees=${result.rows.length}; eligible_passwords=${result.rows.filter((row) => isEligiblePlaintext(row.password)).length}`,
  );
  console.log(
    `LOGGING: general_log=${isEnabled(result.logging.general_log) ? "ON" : "OFF"}; slow_query_log=${isEnabled(result.logging.slow_query_log) ? "ON" : "OFF"}; log_output=${result.logging.log_output}; log_bin=${isEnabled(result.logging.log_bin) ? "ON" : "OFF"}; binlog_format=${result.logging.binlog_format}; global_row_image=${result.logging.global_binlog_row_image}; current_session_row_image=${result.logging.session_binlog_row_image}`,
  );
  if (isEnabled(result.logging.log_bin)) {
    console.log(
      "LOGGING NOTE: Migration will request MINIMAL row images on its connection only. Slow-log entries may include a new hash and employee ID if an update exceeds long_query_time.",
    );
  }
  console.log(
    `PREFLIGHT RESULT: ${checks.every(([, passed]) => passed) ? "PASS" : "FAIL"}`,
  );
}

async function inspect(
  connection: mysql.Connection,
): Promise<Preflight> {
  const [databaseRows] = await connection.query<DatabaseRow[]>(
    "SELECT DATABASE() AS database_name",
  );
  const databaseVerified = databaseRows[0]?.database_name === expectedDatabase;

  const [rows] = await connection.query<EmployeePasswordRow[]>(
    "SELECT employee_id, password FROM employees ORDER BY employee_id",
  );
  const employeeCountVerified = rows.length === expectedEmployeeCount;
  const passwordsVerified =
    employeeCountVerified && rows.every((row) => isEligiblePlaintext(row.password));

  const [engineRows] = await connection.execute<MetadataCountRow[]>(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'employees'
        AND ENGINE = 'InnoDB'`,
  );
  const innodbVerified = engineRows[0]?.total === 1;

  const [primaryKeyRows] = await connection.execute<MetadataCountRow[]>(
    `SELECT COUNT(*) AS total
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'employees'
        AND COLUMN_NAME = 'employee_id'
        AND CONSTRAINT_NAME = 'PRIMARY'`,
  );
  const employeePrimaryKeyVerified = primaryKeyRows[0]?.total === 1;

  const [triggerRows] = await connection.execute<MetadataCountRow[]>(
    `SELECT COUNT(*) AS total
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND EVENT_OBJECT_TABLE = 'employees'`,
  );
  const noTriggersVerified = triggerRows[0]?.total === 0;

  const [loggingRows] = await connection.query<LoggingRow[]>(
    `SELECT @@GLOBAL.general_log AS general_log,
            @@GLOBAL.slow_query_log AS slow_query_log,
            @@GLOBAL.log_output AS log_output,
            @@GLOBAL.log_bin AS log_bin,
            @@GLOBAL.binlog_format AS binlog_format,
            @@GLOBAL.binlog_row_image AS global_binlog_row_image,
            @@SESSION.binlog_row_image AS session_binlog_row_image`,
  );
  const logging = loggingRows[0];
  if (!logging) {
    throw new Error("Database logging configuration could not be checked.");
  }
  const applicationLogChecksPassed =
    !isEnabled(logging.general_log);

  return {
    rows,
    databaseVerified,
    employeeCountVerified,
    passwordsVerified,
    innodbVerified,
    employeePrimaryKeyVerified,
    noTriggersVerified,
    applicationLogChecksPassed,
    logging,
  };
}

function requirePassingPreflight(result: Preflight): void {
  if (
    !result.databaseVerified ||
    !result.employeeCountVerified ||
    !result.passwordsVerified ||
    !result.innodbVerified ||
    !result.employeePrimaryKeyVerified ||
    !result.noTriggersVerified ||
    !result.applicationLogChecksPassed ||
    result.logging.binlog_format.toUpperCase() !== "ROW" ||
    result.logging.global_binlog_row_image.toUpperCase() !== "FULL"
  ) {
    throw new Error("Preflight failed; no password updates were made.");
  }
}

async function requestExplicitConfirmation(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Type MIGRATE ${expectedEmployeeCount} PASSWORDS IN ${expectedDatabase} to continue: `,
    );
    return answer === `MIGRATE ${expectedEmployeeCount} PASSWORDS IN ${expectedDatabase}`;
  } finally {
    prompt.close();
  }
}

async function migrate(
  connection: mysql.Connection,
  preflightRows: EmployeePasswordRow[],
  preflightLogging: LoggingRow,
): Promise<void> {
  const originalPasswords = new Map(
    preflightRows.map((row) => [row.employee_id, row.password as string]),
  );
  const hashes = new Map<string, string>();
  for (const row of preflightRows) {
    hashes.set(row.employee_id, await argon2.hash(row.password!, hashOptions));
  }

  let transactionStarted = false;
  try {
    await connection.query("SET SESSION binlog_row_image = 'MINIMAL'");
    const [sessionRows] = await connection.query<LoggingRow[]>(
      `SELECT @@GLOBAL.binlog_row_image AS global_binlog_row_image,
              @@SESSION.binlog_row_image AS session_binlog_row_image,
              @@GLOBAL.binlog_format AS binlog_format,
              @@GLOBAL.log_bin AS log_bin,
              @@GLOBAL.general_log AS general_log,
              @@GLOBAL.slow_query_log AS slow_query_log,
              @@GLOBAL.log_output AS log_output,
              @@SESSION.sql_log_bin AS session_sql_log_bin`,
    );
    const sessionSettings = sessionRows[0];
    if (
      !sessionSettings ||
      sessionSettings.global_binlog_row_image.toUpperCase() !==
        preflightLogging.global_binlog_row_image.toUpperCase() ||
      sessionSettings.global_binlog_row_image.toUpperCase() !== "FULL" ||
      sessionSettings.session_binlog_row_image.toUpperCase() !== "MINIMAL" ||
      sessionSettings.binlog_format.toUpperCase() !== "ROW" ||
      !isEnabled(sessionSettings.log_bin) ||
      !isEnabled(sessionSettings.session_sql_log_bin ?? "OFF") ||
      isEnabled(sessionSettings.general_log) ||
      isEnabled(sessionSettings.slow_query_log) !==
        isEnabled(preflightLogging.slow_query_log) ||
      sessionSettings.log_output !== preflightLogging.log_output
    ) {
      throw new Error("Session logging safeguards could not be verified; migration aborted.");
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const [lockedRows] = await connection.query<EmployeePasswordRow[]>(
      "SELECT employee_id, password FROM employees ORDER BY employee_id FOR UPDATE",
    );
    if (
      lockedRows.length !== expectedEmployeeCount ||
      !sameEmployeeSet(preflightRows, lockedRows) ||
      !lockedRows.every(
        (row) =>
          isEligiblePlaintext(row.password) &&
          row.password === originalPasswords.get(row.employee_id),
      )
    ) {
      throw new Error("Locked employee rows changed after preflight; migration aborted.");
    }

    for (const row of lockedRows) {
      const hash = hashes.get(row.employee_id);
      if (!hash) {
        throw new Error("A precomputed password hash is missing; migration aborted.");
      }
      const [updateResult] = await connection.execute<ResultSetHeader>(
        "UPDATE employees SET password = ? WHERE employee_id = ?",
        [hash, row.employee_id],
      );
      if (updateResult.affectedRows !== 1) {
        throw new Error("An employee password update did not affect exactly one row.");
      }
    }

    const [updatedRows] = await connection.query<EmployeePasswordRow[]>(
      "SELECT employee_id, password FROM employees ORDER BY employee_id FOR UPDATE",
    );
    if (
      updatedRows.length !== expectedEmployeeCount ||
      !sameEmployeeSet(preflightRows, updatedRows)
    ) {
      throw new Error("Post-update employee verification failed.");
    }

    for (const row of updatedRows) {
      if (
        typeof row.password !== "string" ||
        !row.password.startsWith("$argon2id$") ||
        !(await argon2.verify(row.password, originalPasswords.get(row.employee_id)!))
      ) {
        throw new Error("Post-update Argon2id verification failed.");
      }
    }

    await connection.commit();
    transactionStarted = false;
    console.log(
      `Migration complete: verified ${expectedEmployeeCount} Argon2id password hashes.`,
    );
  } catch {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch {
        throw new Error("Migration failed and rollback could not be confirmed.");
      }
    }
    throw new Error("Migration failed; the transaction was rolled back.");
  }
}

async function main(): Promise<void> {
  const mode = modeFromArgs(process.argv.slice(2));
  const settings = requireDatabaseSettings();
  const connection = await mysql.createConnection(settings);
  try {
    const preflight = await inspect(connection);
    reportPreflight(preflight);

    if (mode === "preflight") {
      requirePassingPreflight(preflight);
      return;
    }

    requirePassingPreflight(preflight);
    if (!(await requestExplicitConfirmation())) {
      console.log("Migration cancelled; no password updates were made.");
      return;
    }
    await migrate(connection, preflight.rows, preflight.logging);
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration preflight failed.");
  process.exitCode = 1;
});

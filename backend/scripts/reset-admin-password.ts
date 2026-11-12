import "dotenv/config";
import argon2 from "argon2";
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";
import { isValidResetPassword, maximumPasswordLength, minimumPasswordLength } from "../src/password-policy.js";

const expectedDatabase = "logistics_db";

type AdminRow = RowDataPacket & {
  employee_id: string;
  role: string;
  employee_status: string | null;
  company_status: string | null;
};

type DatabaseRow = RowDataPacket & {
  database_name: string | null;
};

type LoggingRow = RowDataPacket & {
  global_image: string;
  session_image: string;
  binlog_format: string;
  general_log: string | number;
  slow_query_log: string | number;
};

function readVisibleLine(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  return terminal.question(prompt).finally(() => terminal.close());
}

function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Run the password reset from an interactive terminal."));
  }

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(prompt);

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    };

    const onKeypress = (character: string, key: Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(new Error("Password reset cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(value);
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      if (!key.ctrl && !key.meta && character && character.length === 1) {
        value += character;
        output.write("*");
      }
    };

    input.on("keypress", onKeypress);
  });
}

async function collectDatabaseSettings(): Promise<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}> {
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = Number(process.env.DB_PORT ?? "3306");
  const database = process.env.DB_NAME ?? expectedDatabase;
  const user = process.env.DB_USER ?? "root";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    database !== expectedDatabase
  ) {
    throw new Error("Database configuration is invalid or not the approved target.");
  }

  const password =
    process.env.DB_PASSWORD ?? (await readSecret("MySQL password: "));
  return { host, port, database, user, password };
}

function isEnabled(value: string | number): boolean {
  const normalized = String(value).toUpperCase();
  return normalized === "1" || normalized === "ON";
}

async function main(): Promise<void> {
  const employeeId = (await readVisibleLine("Admin Employee ID: ")).trim();
  if (!employeeId || employeeId.length > 30) {
    throw new Error("Employee ID is invalid.");
  }

  const settings = await collectDatabaseSettings();
  const connection = await mysql.createConnection(settings);
  try {
    const [databaseRows] = await connection.query<DatabaseRow[]>(
      "SELECT DATABASE() AS database_name",
    );
    if (databaseRows[0]?.database_name !== expectedDatabase) {
      throw new Error("Connected database is not logistics_db; no changes were made.");
    }

    const [adminRows] = await connection.execute<AdminRow[]>(
      `SELECT e.employee_id, e.role,
              e.status AS employee_status, c.status AS company_status
         FROM employees e
         JOIN companies c ON c.company_id = e.company_id
        WHERE e.employee_id = ?
        LIMIT 1`,
      [employeeId],
    );
    const candidate = adminRows[0];
    if (
      adminRows.length !== 1 ||
      !candidate ||
      !["ADMIN", "COMPANY_ADMIN"].includes(candidate.role.toUpperCase()) ||
      candidate.employee_status?.toUpperCase() !== "ACTIVE" ||
      candidate.company_status?.toUpperCase() !== "ACTIVE"
    ) {
      throw new Error("No active Company Admin matched; no changes were made.");
    }

    const newPassword = await readSecret("New password (input hidden): ");
    if (!isValidResetPassword(newPassword)) {
      throw new Error(
        `Password must be between ${minimumPasswordLength} and ${maximumPasswordLength} characters.`,
      );
    }
    const confirmation = await readSecret("Confirm new password (input hidden): ");
    if (newPassword !== confirmation) {
      throw new Error("Password entries do not match; no changes were made.");
    }

    const hash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    await connection.query("SET SESSION binlog_row_image = 'MINIMAL'");
    const [loggingRows] = await connection.query<LoggingRow[]>(
      `SELECT @@GLOBAL.binlog_row_image AS global_image,
              @@SESSION.binlog_row_image AS session_image,
              @@GLOBAL.binlog_format AS binlog_format,
              @@GLOBAL.general_log AS general_log,
              @@GLOBAL.slow_query_log AS slow_query_log`,
    );
    const logging = loggingRows[0];
    if (
      !logging ||
      logging.global_image.toUpperCase() !== "FULL" ||
      logging.session_image.toUpperCase() !== "MINIMAL" ||
      logging.binlog_format.toUpperCase() !== "ROW" ||
      isEnabled(logging.general_log) ||
      !isEnabled(logging.slow_query_log)
    ) {
      throw new Error("Database logging safeguards could not be verified; no changes were made.");
    }

    const [triggerRows] = await connection.execute<
      Array<RowDataPacket & { total: number }>
    >(
      `SELECT COUNT(*) AS total
         FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()
          AND EVENT_OBJECT_TABLE = 'employees'`,
    );
    if (triggerRows[0]?.total !== 0) {
      throw new Error("Employee-table triggers are present; no changes were made.");
    }

    const answer = await readVisibleLine(
      "Type RESET ADMIN PASSWORD to update this account: ",
    );
    if (answer !== "RESET ADMIN PASSWORD") {
      console.log("Password reset cancelled; no changes were made.");
      return;
    }

    await connection.beginTransaction();
    let transactionStarted = true;
    try {
      const [rows] = await connection.execute<AdminRow[]>(
        `SELECT e.employee_id, e.role,
                e.status AS employee_status, c.status AS company_status
           FROM employees e
           JOIN companies c ON c.company_id = e.company_id
          WHERE e.employee_id = ?
          FOR UPDATE`,
        [employeeId],
      );
      const admin = rows[0];
      if (
        rows.length !== 1 ||
        !admin ||
        !["ADMIN", "COMPANY_ADMIN"].includes(admin.role.toUpperCase()) ||
        admin.employee_status?.toUpperCase() !== "ACTIVE" ||
        admin.company_status?.toUpperCase() !== "ACTIVE"
      ) {
        throw new Error("No active Company Admin matched; no changes were made.");
      }

      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE employees SET password = ? WHERE employee_id = ?",
        [hash, admin.employee_id],
      );
      if (result.affectedRows !== 1) {
        throw new Error("Password update did not affect exactly one row.");
      }

      const [verifyRows] = await connection.execute<
        Array<RowDataPacket & { password: string | null }>
      >("SELECT password FROM employees WHERE employee_id = ? FOR UPDATE", [
        admin.employee_id,
      ]);
      const storedHash = verifyRows[0]?.password;
      if (
        typeof storedHash !== "string" ||
        !storedHash.startsWith("$argon2id$") ||
        !(await argon2.verify(storedHash, newPassword))
      ) {
        throw new Error("Stored password verification failed.");
      }

      await connection.commit();
      transactionStarted = false;
      console.log("Company Admin password reset successfully.");
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          throw new Error("Password reset failed and rollback could not be confirmed.");
        }
      }
      throw error;
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Password reset failed.");
  process.exitCode = 1;
});

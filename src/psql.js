// Read-only psql escape hatch. Executes a SELECT against the Twenty Postgres
// database inside the `twenty-db-1` docker container.
//
// Safety model:
//   1. Reject any SQL containing write/DDL/session keywords (allowlist is SELECT/WITH/EXPLAIN/VALUES).
//   2. Wrap every statement with `SET default_transaction_read_only = on; SET statement_timeout; SET search_path;`.
//   3. 30s statement timeout + 60s docker exec timeout.
//   4. Cap output rows at 10_000 (enforced via LIMIT injection or result truncation).
//
// The schema defaults to the env var TWENTY_WORKSPACE_SCHEMA, falling back to
// the current PrudAI workspace. Common tables inside that schema: person,
// company, note, "noteTarget", task, "taskTarget", opportunity.

import { spawn } from "node:child_process";

const DEFAULT_CONTAINER = process.env.TWENTY_DB_CONTAINER || "twenty-db-1";
const DEFAULT_DB_USER = process.env.TWENTY_DB_USER || "postgres";
const DEFAULT_DB_NAME = process.env.TWENTY_DB_NAME || "default";
const DEFAULT_SCHEMA = process.env.TWENTY_WORKSPACE_SCHEMA || "workspace_ekaz483h19r9108ifrotkvj69";
const MAX_ROWS = 10_000;
const EXEC_TIMEOUT_MS = 60_000;

const FORBIDDEN = new RegExp(
  String.raw`\b(` +
    [
      "insert", "update", "delete", "drop", "truncate", "alter", "create",
      "grant", "revoke", "vacuum", "reindex", "refresh", "lock", "begin",
      "commit", "rollback", "savepoint", "copy", "call", "notify", "listen",
      "prepare", "deallocate", "discard", "comment", "security", "import",
      "cluster", "reset",
    ].join("|") +
  String.raw`)\b`,
  "i"
);

function assertReadonly(sql) {
  const stripped = sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
  const normalized = stripped.trim();
  if (!normalized) throw new Error("SQL is empty");

  // Must start with SELECT / WITH / EXPLAIN / VALUES / TABLE / SHOW (case-insensitive)
  if (!/^(\s*)(select|with|explain|values|table|show)\b/i.test(normalized)) {
    throw new Error(
      "SQL must start with SELECT, WITH, EXPLAIN, VALUES, TABLE, or SHOW. Write operations are not permitted."
    );
  }
  const forbidden = normalized.match(FORBIDDEN);
  if (forbidden) {
    throw new Error(`SQL contains forbidden keyword: '${forbidden[0]}'. run_sql_readonly is read-only.`);
  }
  // Block semicolons followed by more statements (allow trailing semicolon only).
  const semi = normalized.replace(/;\s*$/, "");
  if (/;/.test(semi)) {
    throw new Error("Multiple statements are not permitted. Remove inner semicolons.");
  }
}

export function buildWrappedSql(userSql, schema = DEFAULT_SCHEMA) {
  const inner = userSql.trim().replace(/;\s*$/, "");
  return [
    "SET default_transaction_read_only = on;",
    "SET statement_timeout = '30s';",
    `SET search_path TO "${schema}", public;`,
    `${inner};`,
  ].join(" ");
}

function runDocker(args, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) return reject(new Error(`psql timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`psql exited ${code}: ${stderr.trim() || stdout.trim()}`));
      resolve({ stdout, stderr });
    });
  });
}

// Run arbitrary read-only SQL. Returns { columns, rows, rowCount, truncated }.
export async function runReadonlySql(userSql, {
  container = DEFAULT_CONTAINER,
  dbUser = DEFAULT_DB_USER,
  dbName = DEFAULT_DB_NAME,
  schema = DEFAULT_SCHEMA,
} = {}) {
  assertReadonly(userSql);
  const wrapped = buildWrappedSql(userSql, schema);

  // -A: unaligned, -F $'\x01' field separator, -R $'\x02' row separator,
  // -t: tuples only, -X: no psqlrc, --csv would escape but we use a safer delim.
  // We use the header + tab-separated output (-A -F \t) with -q silent and
  // keep the first row as column names.
  const args = [
    "exec", "-i", container,
    "psql", "-U", dbUser, "-d", dbName,
    "-X", "-q", "-A", "-F", "\t",
    "--pset=footer=off",
    "-c", wrapped,
  ];

  const { stdout } = await runDocker(args);
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { columns: [], rows: [], rowCount: 0, truncated: false };

  const columns = lines[0].split("\t");
  const dataLines = lines.slice(1);
  const rowCount = dataLines.length;
  const truncated = rowCount > MAX_ROWS;
  const rows = dataLines.slice(0, MAX_ROWS).map((line) => {
    const cells = line.split("\t");
    const row = {};
    columns.forEach((col, i) => {
      row[col] = cells[i] === undefined ? null : cells[i];
    });
    return row;
  });

  return { columns, rows, rowCount: rows.length, truncated };
}

export const psqlDefaults = {
  container: DEFAULT_CONTAINER,
  dbUser: DEFAULT_DB_USER,
  dbName: DEFAULT_DB_NAME,
  schema: DEFAULT_SCHEMA,
};

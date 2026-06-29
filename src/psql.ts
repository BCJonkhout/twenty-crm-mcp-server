// Read-only SQL runner for the Twenty Postgres database.
//
// Two backends, auto-selected at startup:
//   • pg (TCP)     — used when TWENTY_DB_HOST is set. Works from inside
//                     containers (e.g. librechat-api) as long as the MCP
//                     process can reach the db host on the network.
//   • docker exec  — fallback when TWENTY_DB_HOST is not set. Requires the
//                     docker CLI and the caller to be on the same host as
//                     the twenty-db-1 container. This is the path Claude
//                     Code uses.
//
// Safety model (applies to both backends):
//   1. Reject any SQL containing write/DDL/session keywords (allowlist is
//      SELECT/WITH/EXPLAIN/VALUES/TABLE/SHOW).
//   2. Wrap every statement with
//        SET default_transaction_read_only = on;
//        SET statement_timeout = '30s';
//        SET search_path TO "<workspace>", public;
//   3. Hard timeout (30s statement, 60s transport).
//   4. Cap output rows at 10_000.
//
// The schema defaults to TWENTY_WORKSPACE_SCHEMA, falling back to the current
// PrudAI workspace. Common tables in that schema: person, company, note,
// "noteTarget", task, "taskTarget", opportunity.

import { spawn } from "node:child_process";
import type { Client as PgClient } from "pg";

const DEFAULT_CONTAINER = process.env.TWENTY_DB_CONTAINER || "twenty-db-1";
const DEFAULT_DB_HOST: string | null = process.env.TWENTY_DB_HOST || null; // null → fall back to docker exec
const DEFAULT_DB_PORT = Number(process.env.TWENTY_DB_PORT || 5432);
const DEFAULT_DB_USER = process.env.TWENTY_DB_USER || "postgres";
const DEFAULT_DB_PASSWORD = process.env.TWENTY_DB_PASSWORD || "postgres";
const DEFAULT_DB_NAME = process.env.TWENTY_DB_NAME || "default";
const DEFAULT_SCHEMA = process.env.TWENTY_WORKSPACE_SCHEMA || "workspace_ekaz483h19r9108ifrotkvj69";
const MAX_ROWS = 10_000;
const EXEC_TIMEOUT_MS = 60_000;
const STATEMENT_TIMEOUT = "30s";

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
  "i",
);

function assertReadonly(sql: string): void {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const normalized = stripped.trim();
  if (!normalized) throw new Error("SQL is empty");

  if (!/^(\s*)(select|with|explain|values|table|show)\b/i.test(normalized)) {
    throw new Error(
      "SQL must start with SELECT, WITH, EXPLAIN, VALUES, TABLE, or SHOW. Write operations are not permitted.",
    );
  }
  const forbidden = normalized.match(FORBIDDEN);
  if (forbidden) {
    throw new Error(`SQL contains forbidden keyword: '${forbidden[0]}'. run_sql_readonly is read-only.`);
  }
  const semi = normalized.replace(/;\s*$/, "");
  if (/;/.test(semi)) {
    throw new Error("Multiple statements are not permitted. Remove inner semicolons.");
  }
}

export function buildWrappedSql(userSql: string, schema: string = DEFAULT_SCHEMA): string {
  const inner = userSql.trim().replace(/;\s*$/, "");
  return [
    "SET default_transaction_read_only = on;",
    `SET statement_timeout = '${STATEMENT_TIMEOUT}';`,
    `SET search_path TO "${schema}", public;`,
    `${inner};`,
  ].join(" ");
}

export interface SqlResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Backend 1 — pg over TCP
// ---------------------------------------------------------------------------
type PgModule = { Client: new (config: ConstructorParameters<typeof PgClient>[0]) => PgClient };
let _pgModule: PgModule | null = null;
async function getPg(): Promise<PgModule> {
  if (_pgModule) return _pgModule;
  try {
    const mod = await import("pg");
    _pgModule = (mod.default ?? mod) as unknown as PgModule;
    return _pgModule;
  } catch {
    throw new Error(
      "pg package not installed (required when TWENTY_DB_HOST is set). " +
      "Run `bun install` in the twenty-crm-mcp-server directory.",
    );
  }
}

interface PgRunOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema: string;
}

async function runViaPg(userSql: string, opts: PgRunOptions): Promise<SqlResult> {
  const pg = await getPg();
  const client = new pg.Client({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: opts.database,
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query(`SET search_path TO "${opts.schema}", public`);
    const cleanSql = userSql.trim().replace(/;\s*$/, "");
    const result = await client.query(cleanSql);
    const columns = result.fields.map((f) => f.name);
    const rowCount = Math.min(result.rows.length, MAX_ROWS);
    const rows = result.rows.slice(0, MAX_ROWS).map((r: Record<string, unknown>) => {
      // Coerce values to primitives / strings for JSON transport.
      const out: Record<string, unknown> = {};
      for (const col of columns) {
        const v = r[col];
        out[col] = v === null || v === undefined ? null
          : typeof v === "object" && v instanceof Date ? v.toISOString()
          : typeof v === "bigint" ? String(v)
          : v;
      }
      return out;
    });
    return { columns, rows, rowCount, truncated: result.rows.length > MAX_ROWS };
  } finally {
    await client.end().catch(() => { /* swallow */ });
  }
}

// ---------------------------------------------------------------------------
// Backend 2 — docker exec twenty-db-1 psql (host-side fallback)
// ---------------------------------------------------------------------------
interface DockerResult { stdout: string; stderr: string }

function runDocker(args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);

    proc.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      // The most common failure is a missing `docker` CLI — e.g. when this MCP
      // server runs inside a container (librechat-api) that has no docker binary.
      // Node reports this as ENOENT; Bun as `Executable not found in $PATH`.
      // Surface DOCKER_UNAVAILABLE so the caller can emit an accurate, actionable
      // message instead of leaking a raw spawn error.
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT" || /not found in \$PATH|ENOENT/i.test(e.message)) {
        reject(new Error("DOCKER_UNAVAILABLE"));
        return;
      }
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

interface DockerRunOptions {
  container: string;
  dbUser: string;
  dbName: string;
  schema: string;
}

async function runViaDocker(userSql: string, opts: DockerRunOptions): Promise<SqlResult> {
  const wrapped = buildWrappedSql(userSql, opts.schema);
  const args = [
    "exec", "-i", opts.container,
    "psql", "-U", opts.dbUser, "-d", opts.dbName,
    "-X", "-q", "-A", "-F", "\t",
    "--pset=footer=off",
    "-c", wrapped,
  ];
  const { stdout } = await runDocker(args);
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { columns: [], rows: [], rowCount: 0, truncated: false };
  const columns = lines[0]!.split("\t");
  const dataLines = lines.slice(1);
  const truncated = dataLines.length > MAX_ROWS;
  const rows = dataLines.slice(0, MAX_ROWS).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => { row[col] = cells[i] === undefined ? null : cells[i]; });
    return row;
  });
  return { columns, rows, rowCount: rows.length, truncated };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export interface ReadonlySqlOverrides {
  schema?: string;
  host?: string;
  port?: number;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
  container?: string;
}

// Connection/config-level failures, classified by error code so genuine query
// errors (undefined column 42703, undefined table 42P01, syntax 42601, query
// canceled / statement timeout 57014, …) are NEVER misclassified.
const CONNECTION_ERROR_CODES = new Set<string>([
  // Node socket / DNS — host unreachable or unresolvable
  "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "EAI_AGAIN",
  "ECONNRESET", "EPIPE",
  // Postgres SQLSTATE — bad credentials / wrong database (TWENTY_DB_* config)
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
  "3D000", // invalid_catalog_name (database does not exist)
]);

// pg's connection-timeout / termination paths reject with a plain Error that has
// no `.code`; match those by exact phrase (not the bare word "timeout", which
// also appears in the query-level "statement timeout").
const CONNECTION_ERROR_PHRASES =
  /timeout expired|connection terminated|could not connect|server closed the connection|connection refused/i;

function isConnectionLevelError(err: unknown): boolean {
  const e = err as { code?: unknown; syscall?: unknown } | null;
  // DNS resolution ("getaddrinfo") and TCP connect failures are always
  // connection-level, whatever the specific errno (ESERVFAIL, EAI_AGAIN, …).
  if (e?.syscall === "getaddrinfo" || e?.syscall === "connect") return true;
  if (typeof e?.code === "string" && CONNECTION_ERROR_CODES.has(e.code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_PHRASES.test(msg);
}

export async function runReadonlySql(userSql: string, overrides: ReadonlySqlOverrides = {}): Promise<SqlResult> {
  assertReadonly(userSql);
  const schema = overrides.schema ?? DEFAULT_SCHEMA;

  if (DEFAULT_DB_HOST) {
    const host = overrides.host ?? DEFAULT_DB_HOST;
    const port = overrides.port ?? DEFAULT_DB_PORT;
    try {
      return await runViaPg(userSql, {
        host,
        port,
        user: overrides.dbUser ?? DEFAULT_DB_USER,
        password: overrides.dbPassword ?? DEFAULT_DB_PASSWORD,
        database: overrides.dbName ?? DEFAULT_DB_NAME,
        schema,
      });
    } catch (err) {
      // Keep genuine query errors (syntax, unknown column, statement timeout)
      // verbatim — they are actionable as-is and the agent can self-correct.
      // Only re-frame connection/config-level failures, which would otherwise
      // reach the agent as opaque "ECONNREFUSED"/"ENOTFOUND" strings.
      //
      // Classify by error CODE, not message substring: a bare /connect|timeout/
      // match would wrongly swallow real query errors (e.g. the column
      // "connectedAccountId" or a "statement timeout" the agent should fix).
      if (isConnectionLevelError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot connect to the Twenty Postgres database at ${host}:${port} ` +
          `(check TWENTY_DB_* config / network reachability). Underlying error: ${msg}`,
        );
      }
      throw err;
    }
  }

  // No TWENTY_DB_HOST configured → host-side docker-exec fallback. This only
  // works when the docker CLI is present and the twenty-db container is local
  // (the path Claude Code uses on the host). It does NOT work inside a container.
  try {
    return await runViaDocker(userSql, {
      container: overrides.container ?? DEFAULT_CONTAINER,
      dbUser: overrides.dbUser ?? DEFAULT_DB_USER,
      dbName: overrides.dbName ?? DEFAULT_DB_NAME,
      schema,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "DOCKER_UNAVAILABLE") {
      throw new Error(
        "run_sql_readonly is not configured in this environment. No TWENTY_DB_HOST is " +
        "set, so the tool fell back to a `docker exec` against the Twenty DB container, " +
        "but the docker CLI is unavailable here (e.g. inside the librechat-api container). " +
        "Fix: set TWENTY_DB_HOST/TWENTY_DB_PORT/TWENTY_DB_USER/TWENTY_DB_PASSWORD/" +
        "TWENTY_DB_NAME so the tool connects to Postgres directly over TCP. " +
        "(Meanwhile, use the REST-backed tools — search_records, list_companies, " +
        "list_people, count_records — which do not require a DB connection.)",
      );
    }
    throw err;
  }
}

export const psqlDefaults = {
  backend: DEFAULT_DB_HOST ? `pg:${DEFAULT_DB_HOST}:${DEFAULT_DB_PORT}` : `docker:${DEFAULT_CONTAINER}`,
  container: DEFAULT_CONTAINER,
  host: DEFAULT_DB_HOST,
  port: DEFAULT_DB_PORT,
  dbUser: DEFAULT_DB_USER,
  dbName: DEFAULT_DB_NAME,
  schema: DEFAULT_SCHEMA,
} as const;

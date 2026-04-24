import { runReadonlySql, psqlDefaults } from "../psql.ts";
import { text } from "./_render.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolHandler } from "../types.ts";

const OBJECT_TO_TABLE: Record<string, string> = {
  people: "person",
  companies: "company",
  notes: "note",
  tasks: "task",
  noteTargets: "noteTarget",
  taskTargets: "taskTarget",
  opportunities: "opportunity",
  messageThreads: "messageThread",
  messages: "message",
};

// Translate a dotted composite path ("address.addressCity") to the flat
// camelCase Postgres column name ("addressAddressCity").
function toColumn(field: string): string {
  const segs = field.split(".");
  if (segs.length === 1) return segs[0]!;
  return segs.reduce((acc, s, i) => i === 0 ? s : acc + s[0]!.toUpperCase() + s.slice(1));
}

function tableFor(objectType: string): string {
  const t = OBJECT_TO_TABLE[objectType] ?? objectType;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) throw new Error(`Invalid object type: ${objectType}`);
  return t;
}

const FORBIDDEN_IN_WHERE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|call)\b/i;

// User-supplied WHERE snippet is appended verbatim. The sql guard in psql.ts
// still applies; additionally we cap it to simple safe characters here to avoid
// accidental semicolons.
function sanitizeWhere(where: string | undefined): string {
  if (!where) return "";
  if (/;/.test(where)) throw new Error("where clause cannot contain ';'");
  if (FORBIDDEN_IN_WHERE.test(where)) throw new Error("where clause contains forbidden keyword");
  return where;
}

const AGGREGATE_DESCRIPTION = `GROUP BY + count/sum/avg/min/max over a Twenty object. Executes as a read-only SQL query inside the twenty-db-1 postgres container.

Use friendly composite field paths in groupBy / aggregateField — the tool converts them to the flat column names automatically (address.addressCity → addressAddressCity).

⚠ IMPORTANT (Postgres quirk): in the raw \`where\` snippet you MUST double-quote camelCase columns, because unquoted identifiers are folded to lowercase. Use "jobTitle", "addressAddressCity", "prudaiMarketingSourceSystem", etc. — lowercase names like city or name don't need quotes.

Examples:
  • Architects per Twente city (city is lowercase, so no quoting needed):
      objectType: "people"
      groupBy: "city"
      aggregate: "count"
      where: "\\"jobTitle\\" ILIKE '%architect%' AND city IN ('Enschede','Hengelo','Almelo','Oldenzaal','Borne','Losser','Haaksbergen','Tubbergen','Dinkelland','Wierden','Hof van Twente','Rijssen-Holten')"
  • Companies grouped by city (top 20):
      objectType: "companies"
      groupBy: "address.addressCity"
      aggregate: "count"
      limit: 20
  • Sum of annualRecurringRevenue by country:
      objectType: "companies"
      groupBy: "address.addressCountry"
      aggregate: "sum"
      aggregateField: "annualRecurringRevenue.amountMicros"`;

const DISTINCT_DESCRIPTION = `List distinct values of a single field with counts, sorted by frequency.

Examples:
  • Unique job titles across people:
      objectType: "people"
      field: "jobTitle"
      limit: 50
  • Unique SendGrid categories used:
      objectType: "people"
      field: "prudaiMarketingSendgridCategory"`;

export const definitions: Tool[] = [
  {
    name: "aggregate_records",
    description: AGGREGATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string", description: "e.g. 'people', 'companies', 'notes', 'tasks' — or any custom object." },
        groupBy: { type: "string", description: "Field to group on (composite dot-paths OK, e.g. 'address.addressCity')." },
        aggregate: { type: "string", enum: ["count", "sum", "avg", "min", "max"], description: "Default: count." },
        aggregateField: { type: "string", description: "Required for sum/avg/min/max; the numeric field to aggregate." },
        where: { type: "string", description: "Raw SQL WHERE snippet (no semicolons). Applied on top of deletedAt IS NULL unless include_deleted." },
        limit: { type: "number", description: "Max groups to return. Default 100." },
        include_deleted: { type: "boolean" },
      },
      required: ["objectType", "groupBy"],
    },
  },
  {
    name: "distinct_values",
    description: DISTINCT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        objectType: { type: "string" },
        field: { type: "string" },
        where: { type: "string" },
        limit: { type: "number", description: "Default 100." },
        include_deleted: { type: "boolean" },
      },
      required: ["objectType", "field"],
    },
  },
];

interface AggregateArgs {
  objectType: string;
  groupBy: string;
  aggregate?: string;
  aggregateField?: string;
  where?: string;
  limit?: number;
  include_deleted?: boolean;
}

interface DistinctArgs {
  objectType: string;
  field: string;
  where?: string;
  limit?: number;
  include_deleted?: boolean;
}

export function createHandlers(_client?: unknown): Record<string, ToolHandler> {
  void _client;
  return {
    aggregate_records: async (args) => {
      const { objectType, groupBy, aggregate = "count", aggregateField, where, limit = 100, include_deleted = false } = args as unknown as AggregateArgs;
      const table = tableFor(objectType);
      const groupCol = toColumn(groupBy);
      const agg = aggregate.toLowerCase();
      const deletedGuard = include_deleted ? "1=1" : `"deletedAt" IS NULL`;
      const whereSafe = sanitizeWhere(where);
      const whereClause = whereSafe ? `(${deletedGuard}) AND (${whereSafe})` : deletedGuard;

      let aggExpr: string;
      if (agg === "count") {
        aggExpr = "COUNT(*)";
      } else {
        if (!aggregateField) throw new Error(`aggregate=${agg} requires aggregateField`);
        const aggCol = toColumn(aggregateField);
        aggExpr = `${agg.toUpperCase()}("${aggCol}")`;
      }
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 10_000));
      const sql = `SELECT "${groupCol}" AS group_key, ${aggExpr} AS value FROM "${table}" WHERE ${whereClause} GROUP BY "${groupCol}" ORDER BY value DESC NULLS LAST LIMIT ${safeLimit}`;

      const result = await runReadonlySql(sql);
      return text(`Aggregate ${agg}(${aggregateField ?? "*"}) by ${groupBy} on ${objectType}:`, {
        schema: psqlDefaults.schema,
        sql,
        ...result,
      });
    },
    distinct_values: async (args) => {
      const { objectType, field, where, limit = 100, include_deleted = false } = args as unknown as DistinctArgs;
      const table = tableFor(objectType);
      const col = toColumn(field);
      const deletedGuard = include_deleted ? "1=1" : `"deletedAt" IS NULL`;
      const whereSafe = sanitizeWhere(where);
      const whereClause = whereSafe ? `(${deletedGuard}) AND (${whereSafe})` : deletedGuard;
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 10_000));
      const sql = `SELECT "${col}" AS value, COUNT(*) AS count FROM "${table}" WHERE ${whereClause} GROUP BY "${col}" ORDER BY count DESC NULLS LAST LIMIT ${safeLimit}`;
      const result = await runReadonlySql(sql);
      return text(`Distinct ${field} on ${objectType}:`, {
        schema: psqlDefaults.schema,
        sql,
        ...result,
      });
    },
  };
}

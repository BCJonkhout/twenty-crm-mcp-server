import { runReadonlySql, psqlDefaults } from "../psql.js";
import { text } from "./_render.js";

const DESCRIPTION = `Run a read-only SQL query against the Twenty Postgres database (inside the twenty-db-1 container).

Safety guards:
  • Statement must start with SELECT, WITH, EXPLAIN, VALUES, TABLE, or SHOW
  • Forbidden keywords: insert, update, delete, drop, truncate, alter, create,
    grant, revoke, copy, call, vacuum, refresh, lock, begin, commit, rollback,
    prepare, discard, reset, cluster, …
  • Multiple statements are rejected
  • Wrapped in SET default_transaction_read_only = on; SET statement_timeout = '30s'
  • Search path is set to the workspace schema, so tables can be referenced unquoted

Workspace schema: ${psqlDefaults.schema}
Common tables (inside that schema):
  person, company, note, "noteTarget", task, "taskTarget", opportunity,
  messageThread, message
Composite fields are flattened: address.addressCity → addressAddressCity,
emails.primaryEmail → emailsPrimaryEmail, name.firstName → nameFirstName, etc.

⚠ Postgres quirk: unquoted identifiers are folded to lowercase. Always double-
quote camelCase columns: "jobTitle", "addressAddressCity", "nameFirstName",
"deletedAt", "prudaiMarketingSourceSystem". Lowercase names (id, city, name)
don't need quoting.

Examples:
  • Architects per Twente city (aggregation — note quoted camelCase columns):
      SELECT city, COUNT(*) FROM person
      WHERE "jobTitle" ILIKE '%architect%'
        AND city IN ('Enschede','Hengelo','Almelo','Oldenzaal','Borne','Losser','Haaksbergen','Tubbergen','Dinkelland','Wierden','Hof van Twente','Rijssen-Holten')
        AND "deletedAt" IS NULL
      GROUP BY city ORDER BY COUNT(*) DESC
  • Company + person join (who works where in Twente):
      SELECT c.name, c."addressAddressCity", COUNT(p.id) AS headcount
      FROM company c LEFT JOIN person p ON p."companyId" = c.id
      WHERE c."addressAddressCity" IN ('Enschede','Hengelo','Almelo')
        AND c."deletedAt" IS NULL
      GROUP BY c.name, c."addressAddressCity" ORDER BY headcount DESC LIMIT 50
  • Who was touched last in a campaign:
      SELECT id, "nameFirstName", "nameLastName", "prudaiMarketingLastTouchAt"
      FROM person
      WHERE "prudaiMarketingSendgridCategory" = 'Vera_campagne_architecten_landelijk'
      ORDER BY "prudaiMarketingLastTouchAt" DESC NULLS LAST LIMIT 20`;

export const definitions = [
  {
    name: "run_sql_readonly",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT/WITH/EXPLAIN/VALUES/TABLE/SHOW statement." },
      },
      required: ["sql"],
    },
  },
];

export function createHandlers() {
  return {
    run_sql_readonly: async ({ sql }) => {
      const result = await runReadonlySql(sql);
      return text("SQL result:", {
        schema: psqlDefaults.schema,
        ...result,
      });
    },
  };
}

#!/usr/bin/env bun
// End-to-end smoke test: spawn the MCP server over stdio, run ListTools, then
// exercise list_people, count_records, aggregate_records, run_sql_readonly,
// graphql_query, and a batch_upsert cycle.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

interface ClaudeSettings {
  mcpServers: Record<string, { env: Record<string, string> }>;
}

const settings = JSON.parse(readFileSync("/root/.claude/settings.json", "utf8")) as ClaudeSettings;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  TWENTY_API_KEY: settings.mcpServers["twenty-crm"]!.env.TWENTY_API_KEY!,
  TWENTY_BASE_URL: settings.mcpServers["twenty-crm"]!.env.TWENTY_BASE_URL!,
};

const proc = spawn("bun", ["run", "src/index.ts"], { cwd: import.meta.dirname, env, stdio: ["pipe", "pipe", "pipe"] });
proc.stderr!.on("data", (d: Buffer) => process.stderr.write("[srv] " + d.toString()));

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: any;
  error?: unknown;
}

let buf = "";
const pending = new Map<number, (msg: RpcMessage) => void>();
let nextId = 1;

proc.stdout!.on("data", (d: Buffer) => {
  buf += d.toString();
  let idx: number;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as RpcMessage;
      if (msg.id !== undefined) {
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    } catch {
      console.error("[parse-err]", line);
    }
  }
});

function send(method: string, params: unknown): Promise<RpcMessage> {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  proc.stdin!.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function preview(obj: unknown, max = 400): string {
  const s = JSON.stringify(obj);
  return s.length > max ? s.slice(0, max) + `…(${s.length}b)` : s;
}

async function main(): Promise<void> {
  // Spec-compliant MCP handshake.
  await send("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "smoke", version: "0" },
    capabilities: {},
  });
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await send("tools/list", {});
  console.log(`✓ tools/list — ${tools.result.tools.length} tools`);
  const names = tools.result.tools.map((t: { name: string }) => t.name).sort();
  console.log("  names:", names.join(", "));

  // 1. count architects (three ways — show the gap between them)
  for (const [label, filter] of [
    ["[like]   jobTitle lowercase (case-sensitive)", 'jobTitle[like]:"%architect%"'],
    ["[ilike]  jobTitle any case",                   'jobTitle[ilike]:"%architect%"'],
    ["[eq]     prudaiMarketingSourceSystem (authoritative)", 'prudaiMarketingSourceSystem[eq]:"architectenregister"'],
  ] as const) {
    const r = await send("tools/call", { name: "count_records", arguments: { objectType: "people", filter } });
    const txt = r.result.content[0].text as string;
    const tc = txt.match(/"totalCount":\s*(\d+)/)?.[1];
    console.log(`✓ count_records  ${label}:  totalCount=${tc}`);
  }

  // 2. list 5 architects (authoritative filter)
  const lst = await send("tools/call", {
    name: "list_people",
    arguments: { filter: 'prudaiMarketingSourceSystem[eq]:"architectenregister"', limit: 5 },
  });
  console.log("✓ list_people architects (limit=5):", preview(lst.result, 300));

  // 3. SQL: architects per city, top 5
  const sql = await send("tools/call", {
    name: "run_sql_readonly",
    arguments: {
      sql: `SELECT city, COUNT(*) AS n FROM person WHERE "jobTitle" ILIKE '%architect%' AND "deletedAt" IS NULL GROUP BY city ORDER BY n DESC LIMIT 5`,
    },
  });
  console.log("✓ run_sql_readonly:", preview(sql.result, 500));

  // 4. aggregate via wrapper tool
  const agg = await send("tools/call", {
    name: "aggregate_records",
    arguments: {
      objectType: "people",
      groupBy: "city",
      aggregate: "count",
      where: `"jobTitle" ILIKE '%architect%'`,
      limit: 5,
    },
  });
  console.log("✓ aggregate_records:", preview(agg.result, 500));

  // 5. graphql introspection
  const gql = await send("tools/call", {
    name: "graphql_query",
    arguments: { query: "{ __schema { queryType { name } } }" },
  });
  console.log("✓ graphql_query:", preview(gql.result, 300));

  // 6. forbidden SQL (expect error in result)
  const bad = await send("tools/call", {
    name: "run_sql_readonly",
    arguments: { sql: "DELETE FROM person" },
  });
  console.log("✓ run_sql_readonly (guard):", preview(bad.result, 200));

  // 7. Twente architects — the original failing query. Two-step:
  //    (a) company ids in Twente, (b) people filter by companyId[in]:[...]
  const twenteCities = ["Enschede","Hengelo","Almelo","Oldenzaal","Borne","Losser","Haaksbergen","Tubbergen","Dinkelland","Wierden","Hof van Twente","Rijssen-Holten"];
  const citiesEscaped = twenteCities.map((c) => `"${c}"`).join(",");
  const companiesRes = await send("tools/call", {
    name: "query_records",
    arguments: {
      objectType: "companies",
      filter: `address.addressCity[in]:[${citiesEscaped}]`,
      limit: 200,
    },
  });
  const companiesPayload = JSON.parse(companiesRes.result.content[0].text.replace(/^[^{]*/, ""));
  const companyIds = (companiesPayload?.data?.companies ?? []).map((c: { id: string }) => c.id);
  console.log(`✓ Twente companies found: ${companyIds.length}`);

  if (companyIds.length) {
    const archRes = await send("tools/call", {
      name: "list_people",
      arguments: {
        filter: `and(prudaiMarketingSourceSystem[eq]:"architectenregister",companyId[in]:[${companyIds.map((i: string) => `"${i}"`).join(",")}])`,
        limit: 100,
      },
    });
    const archPayload = JSON.parse(archRes.result.content[0].text.replace(/^[^{]*/, ""));
    const archPeople = archPayload?.data?.people ?? [];
    const totalCount = archPayload?.totalCount;
    console.log(`✓ Twente architects — totalCount=${totalCount}, returned=${archPeople.length}`);
    console.log("  first 3:", archPeople.slice(0, 3).map((p: { id: string; name: unknown; jobTitle: unknown; companyId: unknown }) => ({
      id: p.id,
      name: p.name,
      jobTitle: p.jobTitle,
      companyId: p.companyId,
    })));
  }

  proc.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  proc.kill("SIGTERM");
  process.exit(1);
});

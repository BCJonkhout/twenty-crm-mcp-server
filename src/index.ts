#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createRestClient } from "./rest.ts";
import type { ToolHandler, ToolModule } from "./types.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import * as peopleTools from "./tools/people.ts";
import * as companyTools from "./tools/companies.ts";
import * as noteTools from "./tools/notes.ts";
import * as taskTools from "./tools/tasks.ts";
import * as targetTools from "./tools/targets.ts";
import * as queryTools from "./tools/query.ts";
import * as aggregateTools from "./tools/aggregate.ts";
import * as sqlTools from "./tools/sql.ts";
import * as graphqlTools from "./tools/graphql.ts";
import * as batchTools from "./tools/batch.ts";
import * as mergeTools from "./tools/merge.ts";
import * as accessTools from "./tools/access.ts";

const TOOL_MODULES: ToolModule[] = [
  peopleTools, companyTools, noteTools, taskTools, targetTools,
  queryTools, aggregateTools, sqlTools, graphqlTools,
  batchTools, mergeTools, accessTools,
];

async function main(): Promise<void> {
  const apiKey = process.env.TWENTY_API_KEY;
  const baseUrl = process.env.TWENTY_BASE_URL || "https://api.twenty.com";
  if (!apiKey) throw new Error("TWENTY_API_KEY environment variable is required");

  const client = createRestClient({ apiKey, baseUrl });

  const server = new Server(
    { name: "twenty-crm", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  const definitions: Tool[] = [];
  const handlers: Record<string, ToolHandler> = {};
  for (const mod of TOOL_MODULES) {
    for (const def of mod.definitions) {
      if (handlers[def.name]) throw new Error(`Duplicate tool name: ${def.name}`);
      definitions.push(def);
    }
    const mh = mod.createHandlers(client);
    for (const [name, fn] of Object.entries(mh)) {
      handlers[name] = fn;
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];
    if (!handler) {
      return { content: [{ type: "text", text: `Error: unknown tool "${name}"` }] };
    }
    try {
      return await handler(args ?? {});
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Twenty CRM MCP server running on stdio — ${definitions.length} tools registered`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createRestClient } from "./src/rest.js";

import * as peopleTools from "./src/tools/people.js";
import * as companyTools from "./src/tools/companies.js";
import * as noteTools from "./src/tools/notes.js";
import * as taskTools from "./src/tools/tasks.js";
import * as targetTools from "./src/tools/targets.js";
import * as queryTools from "./src/tools/query.js";
import * as aggregateTools from "./src/tools/aggregate.js";
import * as sqlTools from "./src/tools/sql.js";
import * as graphqlTools from "./src/tools/graphql.js";
import * as batchTools from "./src/tools/batch.js";
import * as mergeTools from "./src/tools/merge.js";

const TOOL_MODULES = [
  peopleTools, companyTools, noteTools, taskTools, targetTools,
  queryTools, aggregateTools, sqlTools, graphqlTools,
  batchTools, mergeTools,
];

async function main() {
  const apiKey = process.env.TWENTY_API_KEY;
  const baseUrl = process.env.TWENTY_BASE_URL || "https://api.twenty.com";
  if (!apiKey) throw new Error("TWENTY_API_KEY environment variable is required");

  const client = createRestClient({ apiKey, baseUrl });

  const server = new Server(
    { name: "twenty-crm", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  const definitions = [];
  const handlers = {};
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
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
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

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RestClient } from "./rest.ts";

export type ToolResult = CallToolResult;
export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

export interface ToolModule {
  definitions: Tool[];
  createHandlers(client: RestClient): Record<string, ToolHandler>;
}

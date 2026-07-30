// Uniform response envelope for MCP tool calls.

import type { ToolResult } from "../types.ts";

export function text(label: string, payload: unknown): ToolResult {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text: label ? `${label}\n${body}` : body }] };
}

export function ok(text_: string): ToolResult {
  return { content: [{ type: "text", text: text_ }] };
}

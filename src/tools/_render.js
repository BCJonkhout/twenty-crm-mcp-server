// Uniform response envelope for MCP tool calls.

export function text(label, payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text: label ? `${label}\n${body}` : body }] };
}

export function ok(text_) {
  return { content: [{ type: "text", text: text_ }] };
}

/** Serialize a payload as an MCP text tool result. */
export function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

/** Serialize a payload as an MCP text tool result flagged as an error. */
export function jsonError(payload: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

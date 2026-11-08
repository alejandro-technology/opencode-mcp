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

/** Remediation hint for tools that only recognize this process' task ids. */
export function unknownTaskHint(): string {
  return "unknown task_id; only ids returned by opencode_start_task or opencode_continue_task are trackable (the MCP process does not persist tasks across restarts)";
}

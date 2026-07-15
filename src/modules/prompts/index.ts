import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDelegateTaskPrompt } from "./delegate_task.js";

export function registerPrompts(server: McpServer) {
  registerDelegateTaskPrompt(server);
}

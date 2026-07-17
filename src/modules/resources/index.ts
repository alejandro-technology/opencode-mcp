import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDelegateTaskResource } from "./delegate-task-instructions.js";

export function registerResources(server: McpServer) {
  registerDelegateTaskResource(server);
}

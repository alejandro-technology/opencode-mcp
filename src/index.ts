#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DELEGATE_TASK_INSTRUCTIONS } from "./modules/resources/delegate-task-instructions.js";
import { registerResources } from "./modules/resources/index.js";
import { killAllServers } from "./modules/shared/server-registry.js";
import { registerTools } from "./modules/tools/index.js";

// Create server instance
const server = new McpServer(
  {
    name: "opencode-mcp",
    version: "1.0.0",
    title: "OpenCode MCP",
    description:
      "MCP server that drives an OpenCode instance and delegates work asynchronously to its agents",
    websiteUrl: "https://opencode-mcp.alejandrotechnology.com",
  },
  {
    instructions: DELEGATE_TASK_INSTRUCTIONS,
  },
);

function shutdown(signal: NodeJS.Signals) {
  console.error(`Received ${signal}, stopping tracked OpenCode servers...`);
  killAllServers();
  process.exit(0);
}

// Terminal closed (SIGHUP), Ctrl+C (SIGINT), or a normal kill (SIGTERM):
// make sure no `opencode serve` child keeps running after we die.
process.on("SIGHUP", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Safety net for any other exit path (uncaught exception, process.exit elsewhere).
process.on("exit", killAllServers);

async function main() {
  registerResources(server);
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenCode MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

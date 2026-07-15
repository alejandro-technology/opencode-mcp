#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPrompts } from "./modules/prompts/index.js";
import { killAllServers } from "./modules/shared/server-registry.js";
import { registerTools } from "./modules/tools/index.js";

// Create server instance
const server = new McpServer({
  name: "opencode-mcp",
  version: "1.0.0",
});

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
  registerTools(server);
  registerPrompts(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenCode MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

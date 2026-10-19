#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDelegateTaskInstructions } from "./modules/shared/instructions.js";
import { stopRunObservers } from "./modules/shared/run-observer.js";
import { killAllServers } from "./modules/shared/server-registry.js";
import { registerTools } from "./modules/tools/index.js";

// Create server instance
async function createServer() {
  const instructions = await createDelegateTaskInstructions();
  return new McpServer(
    {
      name: "opencode-mcp",
      version: "1.2.0",
      title: "OpenCode MCP",
      description:
        "MCP server that drives an OpenCode instance and delegates work asynchronously to its agents",
      websiteUrl: "https://opencode-mcp.alejandrotechnology.com",
    },
    {
      instructions,
    },
  );
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Received ${signal}, stopping tracked OpenCode servers...`);
  const checksDrained = await stopRunObservers();
  if (!checksDrained) {
    console.error(
      "One or more check process groups could not be confirmed stopped; OpenCode servers remain active and shutdown can be retried.",
    );
    shuttingDown = false;
    return;
  }
  killAllServers();
  process.exit(exitCode);
}

// Terminal closed (SIGHUP), Ctrl+C (SIGINT), or a normal kill (SIGTERM):
// make sure no `opencode serve` child keeps running after we die.
process.on("SIGHUP", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Safety net for any other exit path (uncaught exception, process.exit elsewhere).
process.on("exit", () => {
  killAllServers();
});

async function main() {
  const server = await createServer();
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenCode MCP Server running on stdio");
}

main().catch(async (error) => {
  console.error("Fatal error in main():", error);
  await shutdown("SIGTERM", 1);
});

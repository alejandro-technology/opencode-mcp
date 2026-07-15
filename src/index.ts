import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./modules/tools/index.js";

// Create server instance
const server = new McpServer({
  name: "opencode-mcp",
  version: "1.0.0",
});

async function main() {
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenCode MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

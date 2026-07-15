import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerOpencodeStartServer(server: McpServer) {
  server.registerTool(
    "opencode_start_server",
    {
      description: "Start (or attach to) an OpenCode server instance",
      inputSchema: {
        cwd: z.string().optional().describe("Working directory for the OpenCode instance"),
        port: z.number().optional().describe("Port to bind the server on"),
      },
    },
    async ({ cwd: _cwd, port }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              server_id: "mock-server-id",
              baseUrl: `http://127.0.0.1:${port ?? 4096}`,
              status: "running",
            }),
          },
        ],
      };
    },
  );
}

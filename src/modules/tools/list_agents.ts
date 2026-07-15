import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerOpencodeListAgents(server: McpServer) {
  server.registerTool(
    "opencode_list_agents",
    {
      description: "List agents/models available on an OpenCode server instance",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to query"),
      },
    },
    async ({ server_id }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              server_id,
              agents: [
                { name: "mock-agent-a", model: "mock-model-a" },
                { name: "mock-agent-b", model: "mock-model-b" },
              ],
            }),
          },
        ],
      };
    },
  );
}

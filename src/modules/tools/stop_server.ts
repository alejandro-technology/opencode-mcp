import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServer, removeServer } from "../shared/server-registry.js";

export function registerOpencodeStopServer(server: McpServer) {
  server.registerTool(
    "opencode_stop_server",
    {
      description: "Stop a running OpenCode server instance",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to stop"),
      },
    },
    async ({ server_id }) => {
      const instance = getServer(server_id);
      if (!instance) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ server_id, status: "not_found" }),
            },
          ],
        };
      }

      instance.close();
      removeServer(server_id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ server_id, status: "stopped" }),
          },
        ],
      };
    },
  );
}

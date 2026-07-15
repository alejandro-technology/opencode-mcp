import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import { getServer } from "../shared/server-registry.js";

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

      try {
        const client = createOpencodeClient({ baseUrl: instance.baseUrl });
        const { data, error } = await client.app.agents();

        if (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  server_id,
                  status: "error",
                  message:
                    typeof error === "object" && error !== null && "message" in error
                      ? String(error.message)
                      : String(error),
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server_id,
                agents: data ?? [],
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server_id,
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );
}

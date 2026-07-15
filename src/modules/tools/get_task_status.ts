import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerOpencodeGetTaskStatus(server: McpServer) {
  server.registerTool(
    "opencode_get_task_status",
    {
      description: "Get the current status of a delegated task",
      inputSchema: {
        task_id: z.string().describe("Id of the task to check"),
      },
    },
    async ({ task_id }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ task_id, status: "running" }),
          },
        ],
      };
    },
  );
}

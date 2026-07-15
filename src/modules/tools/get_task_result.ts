import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerOpencodeGetTaskResult(server: McpServer) {
  server.registerTool(
    "opencode_get_task_result",
    {
      description: "Get the final result of a completed task",
      inputSchema: {
        task_id: z.string().describe("Id of the task to fetch the result for"),
      },
    },
    async ({ task_id }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              task_id,
              status: "completed",
              result: "mock result",
            }),
          },
        ],
      };
    },
  );
}

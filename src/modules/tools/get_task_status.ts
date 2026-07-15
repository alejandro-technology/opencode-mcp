import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask, deriveTaskStatus } from "../shared/opencode-client.js";

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
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "not_found" });
      }
      const { client, sessionId } = resolved;

      try {
        const result = await deriveTaskStatus(client, sessionId, task_id);
        return jsonResult(result);
      } catch (error) {
        return jsonError({
          task_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

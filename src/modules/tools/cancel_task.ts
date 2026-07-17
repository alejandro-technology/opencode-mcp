import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask } from "../shared/opencode-client.js";

export function registerOpencodeCancelTask(server: McpServer) {
  server.registerTool(
    "opencode_cancel_task",
    {
      description: "Cancel a delegated task by aborting its OpenCode session",
      inputSchema: {
        task_id: z.string().describe("Id of the task to cancel"),
      },
    },
    async ({ task_id }) => {
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "task_not_found" });
      }
      const { client, sessionId } = resolved;

      try {
        await client.session.abort({ path: { id: sessionId } });

        return jsonResult({
          task_id,
          session_id: sessionId,
          status: "cancelled",
        });
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

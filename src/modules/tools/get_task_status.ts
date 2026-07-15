import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask, lastAssistantEntry } from "../shared/opencode-client.js";

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
        // The status map only lists sessions that are actively working.
        const statusRes = await client.session.status();
        const sessionStatus = statusRes.data?.[sessionId];
        if (sessionStatus?.type === "busy" || sessionStatus?.type === "retry") {
          return jsonResult({ task_id, status: "running" });
        }

        // Not busy: inspect the last assistant message to tell pending from done.
        const entry = await lastAssistantEntry(client, sessionId);
        if (!entry) {
          return jsonResult({ task_id, status: "pending" });
        }
        if (entry.info.error) {
          return jsonResult({ task_id, status: "failed", error: entry.info.error.name });
        }
        if (entry.info.time.completed) {
          return jsonResult({ task_id, status: "completed" });
        }
        return jsonResult({ task_id, status: "running" });
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask, lastAssistantEntry } from "../shared/opencode-client.js";

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
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "not_found" });
      }
      const { client, sessionId } = resolved;

      try {
        const entry = await lastAssistantEntry(client, sessionId);
        if (!entry) {
          return jsonResult({ task_id, status: "pending", result: null });
        }
        if (entry.info.error) {
          return jsonResult({
            task_id,
            status: "failed",
            error: entry.info.error.name,
            result: null,
          });
        }
        if (!entry.info.time.completed) {
          return jsonResult({ task_id, status: "running", result: null });
        }

        const text = entry.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");

        return jsonResult({ task_id, status: "completed", result: text });
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

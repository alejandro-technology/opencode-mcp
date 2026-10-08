import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask } from "../shared/opencode-client.js";
import { finishConfirmedCancellation } from "../shared/run-observer.js";
import {
  markTaskCancelled,
  releaseTaskDispatch,
  reserveTaskDispatch,
} from "../shared/task-registry.js";

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

      if (!reserveTaskDispatch(task_id)) {
        return jsonError({ task_id, status: "dispatch_in_progress" });
      }

      try {
        const response = await client.session.abort({ path: { id: sessionId } });
        if (
          typeof response === "object" &&
          response !== null &&
          "error" in response &&
          response.error
        ) {
          throw response.error;
        }
        if (
          typeof response !== "object" ||
          response === null ||
          !("data" in response) ||
          response.data !== true
        ) {
          return jsonError({
            task_id,
            status: "cancellation_not_confirmed",
            message:
              "OpenCode did not confirm that the session was aborted; task state and workspace lease are retained",
          });
        }
        // Aborting alone leaves no trace: the session's last assistant message
        // still carries a completed timestamp, so status derivation would
        // report `completed` for a task the caller deliberately killed.
        markTaskCancelled(task_id);
        await finishConfirmedCancellation(task_id);

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
      } finally {
        releaseTaskDispatch(task_id);
      }
    },
  );
}

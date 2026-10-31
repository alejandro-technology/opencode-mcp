import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenCodeClient } from "@opencode/client";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask } from "../shared/opencode-client.js";
import { finishConfirmedCancellation } from "../shared/run-observer.js";
import {
  getTask,
  markTaskCancelled,
  releaseTaskDispatch,
  reserveTaskDispatch,
} from "../shared/task-registry.js";

const SESSION_IDLE_TIMEOUT_MS = 10_000;
const SESSION_IDLE_POLL_MS = 100;

async function waitForSessionIdle(client: OpenCodeClient, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + SESSION_IDLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const active = await client.session.active({
      signal: AbortSignal.timeout(Math.min(1_000, remaining)),
    });
    if (!active[sessionId]) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(SESSION_IDLE_POLL_MS, remaining)));
  }
  return false;
}

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
        const response = await client.session.interrupt({ sessionID: sessionId, resume: false });
        const task = getTask(task_id);
        const run = task?.runs?.find((item) => item.run_id === task.currentRunId);
        const interrupted = response.interrupted;
        let queuedCancelled = false;
        const inboxID = run?.inboxId ?? (!interrupted ? run?.message_id : undefined);
        if (inboxID) {
          try {
            await client.session.inbox.cancel({ sessionID: sessionId, inboxID });
            queuedCancelled = true;
          } catch (error) {
            if (!interrupted) throw error;
          }
        }
        if (!interrupted && !queuedCancelled) {
          return jsonError({
            task_id,
            status: "cancellation_not_confirmed",
            message:
              "OpenCode did not confirm that the session was aborted or queued prompt cancelled; task state and workspace lease are retained",
          });
        }
        if (!(await waitForSessionIdle(client, sessionId))) {
          return jsonError({
            task_id,
            status: "cancellation_pending",
            message:
              "OpenCode accepted cancellation but the session remained active; task state and workspace lease are retained",
          });
        }
        // CLI2 accepts interruption immediately and settles writer cleanup asynchronously.
        // Do not finalize reports, restore selections, or release leases until it is idle.
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

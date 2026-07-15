import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMaxToolTimeoutMs } from "../shared/config.js";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import {
  clientForTask,
  deriveTaskStatus,
  type TaskStatusResult,
} from "../shared/opencode-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const MIN_POLL_INTERVAL_MS = 500;

/** A task result as tracked by the wait loop; adds the "error" status for per-task SDK failures. */
type WaitTaskResult = TaskStatusResult | { task_id: string; status: "error"; error: string };

const FINISHED_STATUSES = new Set(["completed", "failed", "error"]);

function isFinished(result: WaitTaskResult | undefined): boolean {
  return result !== undefined && FINISHED_STATUSES.has(result.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerOpencodeWaitForTask(server: McpServer) {
  server.registerTool(
    "opencode_wait_for_task",
    {
      description:
        "Long-poll one or more delegated tasks until they finish or the timeout elapses. Use mode 'all' to wait for all tasks, or 'any' to return as soon as one completes.",
      inputSchema: {
        task_ids: z.string().array().min(1).describe("IDs of tasks to wait for"),
        mode: z
          .enum(["all", "any"])
          .default("all")
          .describe("'all': return when all tasks finish, 'any': return when one finishes"),
        timeout_ms: z
          .number()
          .optional()
          .describe(`Max time to wait in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
        poll_interval_ms: z
          .number()
          .optional()
          .describe(
            `Time between status checks in milliseconds (default ${DEFAULT_POLL_INTERVAL_MS})`,
          ),
      },
    },
    async ({ task_ids, mode = "all", timeout_ms, poll_interval_ms }) => {
      // Fail-fast: check for unknown task IDs before polling starts
      const unknownIds: string[] = [];
      const taskData: Array<{
        task_id: string;
        client: NonNullable<ReturnType<typeof clientForTask>>;
      }> = [];

      for (const taskId of task_ids) {
        const resolved = clientForTask(taskId);
        if (!resolved) {
          unknownIds.push(taskId);
        } else {
          taskData.push({ task_id: taskId, client: resolved });
        }
      }

      if (unknownIds.length > 0) {
        return jsonError({ task_ids: unknownIds, status: "not_found" });
      }

      const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, getMaxToolTimeoutMs());
      const pollInterval = Math.max(
        poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS,
        MIN_POLL_INTERVAL_MS,
      );

      const deadline = Date.now() + timeout;
      const statusMap = new Map<string, WaitTaskResult>();

      while (true) {
        // Poll all tasks that are not yet finished
        for (const { task_id, client } of taskData) {
          if (isFinished(statusMap.get(task_id))) continue;

          try {
            const result = await deriveTaskStatus(client.client, client.sessionId, task_id);
            statusMap.set(task_id, result);
          } catch (error) {
            // Per-task SDK error: mark as finished with error
            statusMap.set(task_id, {
              task_id,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // biome-ignore lint/style/noNonNullAssertion: every task_id was just written to statusMap above
        const tasks = task_ids.map((id) => statusMap.get(id)!);

        if (mode === "all" && tasks.every(isFinished)) {
          return jsonResult({ mode, tasks, timed_out: false });
        }

        if (mode === "any" && tasks.some(isFinished)) {
          return jsonResult({ mode, tasks, timed_out: false });
        }

        if (Date.now() >= deadline) {
          return jsonResult({ mode, tasks, timed_out: true });
        }

        await sleep(pollInterval);
      }
    },
  );
}

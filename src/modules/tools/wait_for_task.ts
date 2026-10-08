import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMaxToolTimeoutMs } from "../shared/config.js";
import type { ExecutionUsageSnapshot } from "../shared/execution-usage.js";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import {
  clientForTask,
  deriveTaskStatus,
  isTerminalTaskStatus,
  type TaskStatus,
  type TaskStatusResult,
} from "../shared/opencode-client.js";
import { getTask } from "../shared/task-registry.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const MIN_POLL_INTERVAL_MS = 500;

/** A task result as tracked by the wait loop; adds the "error" status for per-task SDK failures. */
type WaitTaskResult =
  | TaskStatusResult
  | { task_id: string; status: "error"; error: string; usage?: ExecutionUsageSnapshot };

function isFinished(result: WaitTaskResult | undefined): boolean {
  return result !== undefined && isTerminalTaskStatus(result.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-derive status with progress for every task that is not yet finished.
 * Only called once, right before returning a final result, never inside the
 * poll loop. Failures are swallowed per-task so one bad re-derivation doesn't
 * fail the whole call.
 */
async function enrichUnfinishedWithProgress(
  tasks: WaitTaskResult[],
  taskData: Array<{ task_id: string; client: NonNullable<ReturnType<typeof clientForTask>> }>,
  deadline: number,
): Promise<WaitTaskResult[]> {
  const clientByTaskId = new Map(taskData.map((entry) => [entry.task_id, entry.client]));

  return Promise.all(
    tasks.map(async (task) => {
      if (isFinished(task)) return task;
      // Every task_id in `tasks` was resolved into taskData before polling started.
      // biome-ignore lint/style/noNonNullAssertion: guaranteed present, see comment above
      const client = clientByTaskId.get(task.task_id)!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return task;

      const controller = new AbortController();
      try {
        return await pollUntilDeadline(
          deriveTaskStatus(client.client, client.sessionId, task.task_id, {
            includeProgress: true,
            includeUsage: true,
            signal: controller.signal,
          }),
          remaining,
          () => controller.abort(new Error("wait deadline exceeded")),
        );
      } catch {
        return task;
      }
    }),
  );
}

async function pollUntilDeadline<T>(
  operation: Promise<T>,
  remainingMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error("status poll deadline exceeded"));
        }, remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerOpencodeWaitForTask(server: McpServer) {
  server.registerTool(
    "opencode_wait_for_task",
    {
      description:
        "Long-poll one or more delegated tasks until they finish or the timeout elapses. Use mode 'all' to wait for all tasks, or 'any' to return as soon as one completes. Set include_progress to best-effort enrich still-running tasks within the same wait deadline; when time runs out, return the last observed status and progress.",
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
        until: z
          .enum(["execution", "report"])
          .optional()
          .describe("Wait for execution (default) or finalized execution report"),
        include_progress: z
          .boolean()
          .optional()
          .describe(
            "If true, best-effort enrich unfinished tasks with a partial output snippet and the currently running tool, without extending the wait deadline",
          ),
      },
    },
    async ({
      task_ids,
      mode = "all",
      timeout_ms,
      poll_interval_ms,
      include_progress,
      until = "execution",
    }) => {
      // Fail-fast: check for unknown task IDs before polling starts
      const unknownIds: string[] = [];
      const taskData: Array<{
        task_id: string;
        client: ReturnType<typeof clientForTask>;
      }> = [];

      for (const taskId of task_ids) {
        const resolved = clientForTask(taskId);
        const tracked = getTask(taskId);
        const cached = tracked?.runs?.find((run) => run.run_id === tracked.currentRunId);
        if (
          (!tracked && !resolved) ||
          (!resolved && until === "execution" && !cached?.reportReady)
        ) {
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
          const currentRun = getTask(task_id)?.runs?.find(
            (run) => run.run_id === getTask(task_id)?.currentRunId,
          );
          if (currentRun?.reportReady) {
            const cachedStatus = currentRun.result?.status ?? currentRun.executionState ?? "error";
            statusMap.set(
              task_id,
              cachedStatus === "error"
                ? {
                    task_id,
                    status: "error",
                    error: currentRun.result?.error ?? "execution report unavailable",
                  }
                : { task_id, status: cachedStatus as TaskStatus },
            );
            continue;
          }
          if (isFinished(statusMap.get(task_id))) continue;
          if (!client) {
            statusMap.set(task_id, { task_id, status: "running" });
            continue;
          }

          try {
            const remaining = Math.max(1, deadline - Date.now());
            const controller = new AbortController();
            const result = await pollUntilDeadline(
              deriveTaskStatus(client.client, client.sessionId, task_id, {
                includeUsage: true,
                signal: controller.signal,
              }),
              remaining,
              () => controller.abort(new Error("wait deadline exceeded")),
            );
            statusMap.set(task_id, result);
          } catch (error) {
            // The overall deadline returns the last known live status rather than
            // converting a slow read into a completed per-task error.
            statusMap.set(
              task_id,
              Date.now() >= deadline
                ? (statusMap.get(task_id) ?? { task_id, status: "running" })
                : {
                    task_id,
                    status: "error",
                    error: error instanceof Error ? error.message : String(error),
                    usage: {
                      captured_at: new Date().toISOString(),
                      snapshot_kind: "live_observation",
                      report: null,
                      diagnostic: `usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
                    },
                  },
            );
          }
        }

        // biome-ignore lint/style/noNonNullAssertion: every task_id was just written to statusMap above
        const tasks = task_ids.map((id) => statusMap.get(id)!);

        const done = (task: WaitTaskResult) =>
          until === "report"
            ? Boolean(
                getTask(task.task_id)?.runs?.find(
                  (run) => run.run_id === getTask(task.task_id)?.currentRunId,
                )?.reportReady,
              )
            : isFinished(task);
        if (mode === "all" && tasks.every(done)) {
          return jsonResult({ mode, tasks: addReports(tasks), timed_out: false });
        }

        if (mode === "any" && tasks.some(done)) {
          const enriched = include_progress
            ? await enrichUnfinishedWithProgress(
                tasks,
                taskData.filter(
                  (item): item is { task_id: string; client: NonNullable<typeof item.client> } =>
                    Boolean(item.client),
                ),
                deadline,
              )
            : tasks;
          return jsonResult({ mode, tasks: addReports(enriched), timed_out: false });
        }

        if (Date.now() >= deadline) {
          const enriched = include_progress
            ? await enrichUnfinishedWithProgress(
                tasks,
                taskData.filter(
                  (item): item is { task_id: string; client: NonNullable<typeof item.client> } =>
                    Boolean(item.client),
                ),
                deadline,
              )
            : tasks;
          return jsonResult({ mode, tasks: addReports(enriched), timed_out: true });
        }

        await sleep(pollInterval);
      }
    },
  );
}

function addReports(tasks: WaitTaskResult[]): Array<WaitTaskResult | Record<string, unknown>> {
  return tasks.map((result) => {
    const task = getTask(result.task_id);
    const run = task?.runs?.find((item) => item.run_id === task.currentRunId);
    if (!run) return result;
    return {
      ...result,
      ...(run.reportReady && run.executionState ? { status: run.executionState } : {}),
      run_id: run.run_id,
      changes: run.report?.changes ?? [],
      verification: run.report?.verification ?? { state: "pending", checks: [] },
      diagnostics: run.report?.diagnostics ?? [],
      evidence: run.report?.evidence,
      ...(run.usage ? { usage: run.usage } : {}),
      ...(task?.workspace ? { workspace: task.workspace } : {}),
      ...(run.dispatchState === "uncertain"
        ? { dispatch: { state: run.dispatchState, error: run.dispatchError } }
        : {}),
    };
  });
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask, deriveTaskStatus } from "../shared/opencode-client.js";
import { getTask, type TaskRunRecord } from "../shared/task-registry.js";

function reportFields(run: TaskRunRecord) {
  return {
    run_id: run.run_id,
    changes: run.report?.changes ?? [],
    verification: run.report?.verification ?? {
      state: run.reportReady
        ? "unavailable"
        : run.expectedChanges?.length || run.checks?.length
          ? "pending"
          : "not_requested",
      checks: [],
    },
    diagnostics: run.report?.diagnostics ?? [],
    evidence: run.report?.evidence,
    ...(run.usage ? { usage: run.usage } : {}),
    ...(run.dispatchState === "uncertain"
      ? { dispatch: { state: run.dispatchState, error: run.dispatchError } }
      : {}),
  };
}

export function registerOpencodeGetTaskStatus(server: McpServer) {
  server.registerTool(
    "opencode_get_task_status",
    {
      description: "Get the current status of a delegated task",
      inputSchema: {
        task_id: z.string().describe("Id of the task to check"),
        run_id: z
          .string()
          .optional()
          .describe("Historical run id; defaults to the task's current run"),
        include_progress: z
          .boolean()
          .optional()
          .describe("Include partial output and current tool progress"),
      },
    },
    async ({ task_id, run_id, include_progress }) => {
      const task = getTask(task_id);
      const run = task?.runs?.find((item) => item.run_id === (run_id ?? task.currentRunId));
      if (run_id && !run) return jsonError({ task_id, run_id, status: "run_not_found" });
      if (run_id && run_id !== task?.currentRunId && run) {
        const cached = run?.result;
        return jsonResult({
          task_id,
          workspace: task?.workspace,
          status: cached?.status ?? run?.executionState ?? "unavailable",
          ...(cached?.progress ? { progress: cached.progress } : {}),
          ...reportFields(run),
        });
      }
      if (run?.reportReady && run.result) {
        return jsonResult({ ...run.result, workspace: task?.workspace, ...reportFields(run) });
      }
      const resolved = clientForTask(task_id);
      if (!resolved) {
        if (run?.result)
          return jsonResult({ ...run.result, workspace: task?.workspace, ...reportFields(run) });
        if (!task) return jsonError({ task_id, status: "not_found" });
        return jsonError({
          task_id,
          status: "backend_unavailable",
          workspace: task.workspace,
          ...(run ? reportFields(run) : {}),
        });
      }
      try {
        const result = await deriveTaskStatus(resolved.client, resolved.sessionId, task_id, {
          includeProgress: include_progress,
          includeUsage: true,
        });
        return jsonResult({
          ...result,
          workspace: task?.workspace,
          ...(run ? reportFields(run) : {}),
        });
      } catch (error) {
        return jsonError({
          task_id,
          status: "error",
          workspace: task?.workspace,
          message: error instanceof Error ? error.message : String(error),
          usage: {
            captured_at: new Date().toISOString(),
            snapshot_kind: "live_observation",
            report: null,
            diagnostic: `usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
          },
          ...(run ? reportFields(run) : {}),
        });
      }
    },
  );
}

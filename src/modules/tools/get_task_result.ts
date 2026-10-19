import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Part } from "@opencode-ai/sdk";
import { z } from "zod";
import { buildExecutionUsage } from "../shared/execution-usage.js";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import {
  assistantEntries,
  buildProgress,
  CANCELLED_TASK_MESSAGE,
  clientForTask,
  deriveAssistantTurnStatus,
  EMPTY_TURN_MESSAGE,
  hasWork,
  sessionParts,
} from "../shared/opencode-client.js";
import { type CachedTaskResult, getTask, type TaskRunRecord } from "../shared/task-registry.js";

function joinText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function reportFields(run: TaskRunRecord) {
  return {
    run_id: run.run_id,
    changes: run.report?.changes ?? [],
    verification: run.report?.verification ?? {
      state: run.reportReady ? "unavailable" : "pending",
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

export function registerOpencodeGetTaskResult(server: McpServer) {
  server.registerTool(
    "opencode_get_task_result",
    {
      description: "Get a task result and its finalized execution report",
      inputSchema: {
        task_id: z.string().describe("Id of the task to fetch the result for"),
        run_id: z
          .string()
          .optional()
          .describe("Historical run id; defaults to the task's current run"),
      },
    },
    async ({ task_id, run_id }) => {
      const task = getTask(task_id);
      const run = task?.runs?.find((item) => item.run_id === (run_id ?? task.currentRunId));
      if (run_id && !run) return jsonError({ task_id, run_id, status: "run_not_found" });
      if (run?.reportReady && run.result)
        return jsonResult({ ...run.result, workspace: task?.workspace, ...reportFields(run) });
      if (run_id && run_id !== task?.currentRunId && run)
        return jsonResult({
          task_id,
          workspace: task?.workspace,
          ...reportFields(run),
          status: run.executionState ?? "unavailable",
          result: null,
        });

      const resolved = clientForTask(task_id);
      if (!resolved) {
        if (run?.result)
          return jsonResult({ ...run.result, workspace: task?.workspace, ...reportFields(run) });
        if (!task) return jsonError({ task_id, status: "not_found" });
        return jsonError({
          task_id,
          status: "backend_unavailable",
          workspace: task.workspace,
          run_id: run?.run_id,
          ...(run?.report ? reportFields(run) : {}),
        });
      }

      try {
        const allEntries = await assistantEntries(resolved.client, resolved.sessionId);
        const entries = run
          ? allEntries.filter((item) => item.info.parentID === run.message_id)
          : allEntries;
        const entry = entries.at(-1);
        const usage = {
          captured_at: new Date().toISOString(),
          snapshot_kind: run?.reportReady
            ? ("run_finalization" as const)
            : ("live_observation" as const),
          report: buildExecutionUsage(allEntries, run?.message_id),
        };
        let payload: Record<string, unknown>;
        if (task?.cancelledAt !== undefined) {
          const text = joinText(entry?.parts ?? []);
          payload = {
            task_id,
            status: "cancelled",
            result: text === "" ? null : text,
            message: CANCELLED_TASK_MESSAGE,
            progress: buildProgress(entry?.parts ?? [], sessionParts(entries)),
            usage,
          };
        } else if (!entry) {
          payload = { task_id, status: "pending", result: null, usage };
        } else {
          const turn = deriveAssistantTurnStatus(entry);
          const progress = buildProgress(entry.parts, sessionParts(entries));
          if (turn.status === "running")
            payload = { task_id, status: turn.status, result: null, usage };
          else if (turn.status === "failed")
            payload = { task_id, status: turn.status, error: turn.error, result: null, usage };
          else if (turn.status === "empty" || !hasWork(entry.parts))
            payload = {
              task_id,
              status: "empty",
              result: null,
              message: EMPTY_TURN_MESSAGE,
              progress,
              usage,
            };
          else
            payload = {
              task_id,
              status: "completed",
              result: joinText(entry.parts),
              progress,
              usage,
            };
        }
        if (run?.reportReady) {
          run.usage ??= usage;
          payload = { ...payload, usage: run.usage };
          run.result = payload as CachedTaskResult;
          payload = { ...run.result, ...reportFields(run) };
        }
        return jsonResult({
          ...payload,
          workspace: task?.workspace,
          ...(run ? reportFields(run) : {}),
        });
      } catch (error) {
        return jsonError({
          task_id,
          run_id: run?.run_id,
          status: "error",
          workspace: task?.workspace,
          message: error instanceof Error ? error.message : String(error),
          usage: {
            captured_at: new Date().toISOString(),
            snapshot_kind: "live_observation",
            report: null,
            diagnostic: `usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
          },
          ...(run?.report ? reportFields(run) : {}),
        });
      }
    },
  );
}

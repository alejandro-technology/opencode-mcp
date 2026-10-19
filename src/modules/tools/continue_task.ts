import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  captureWorkspace,
  type ExpectedChange,
  releaseWorkspace,
  reserveWorkspace,
  type VerificationCheck,
  validateRelativeCwd,
  validateRelativePath,
  type WorkspaceSnapshot,
} from "../shared/execution-report.js";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { createMessageId } from "../shared/message-id.js";
import { clientForTask } from "../shared/opencode-client.js";
import { sendPromptAndClassify } from "../shared/prompt-dispatch.js";
import { observeRun } from "../shared/run-observer.js";
import {
  acceptTaskRun,
  getTask,
  releaseTaskDispatch,
  reserveTaskDispatch,
  rollbackTaskRun,
  type TaskRunRecord,
} from "../shared/task-registry.js";
import { acquireManagedWorkspaceDispatch } from "../shared/workspace-manager.js";

const expectedChangeSchema = z.object({
  path: z.string().refine(validateRelativePath),
  change: z.enum(["created", "modified", "deleted"]),
});
const checkSchema = z.object({
  executable: z.string().min(1),
  argv: z.array(z.string()),
  cwd: z.string().refine(validateRelativeCwd).optional(),
  timeout_ms: z.number().int().positive().max(300_000).optional(),
});

/** Parse a "providerID/modelID" string into the shape the SDK expects. */
function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function registerOpencodeContinueTask(server: McpServer) {
  server.registerTool(
    "opencode_continue_task",
    {
      description: "Send a follow-up prompt to an existing delegated task's session",
      inputSchema: {
        task_id: z
          .string()
          .describe("Id of the task whose session should receive the follow-up prompt"),
        prompt: z.string().describe("Follow-up prompt/instructions for the agent"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent name to delegate to (e.g. 'build', 'plan'). Discover available agents with opencode_list_agents. Omit to use the session's current agent",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model override as 'providerID/modelID' (e.g. 'opencode-go/glm-5.2'). Overrides the agent's pre-assigned model for this follow-up only. Discover available models with opencode_list_agents",
          ),
        expected_changes: z.array(expectedChangeSchema).optional(),
        checks: z.array(checkSchema).optional(),
      },
    },
    async ({ task_id, prompt, agent, model, expected_changes, checks }) => {
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "task_not_found" });
      }
      const { client, sessionId } = resolved;
      const task = getTask(task_id);
      if (!task) return jsonError({ task_id, status: "task_not_found" });
      const previous = task?.runs?.find((run) => run.run_id === task.currentRunId);
      if (previous && !previous.reportReady)
        return jsonError({ task_id, status: "previous_run_reporting" });
      if (previous?.report && previous.finalizationError)
        return jsonError({ task_id, status: "previous_run_unavailable" });
      if (
        previous?.report &&
        !["completed", "failed", "empty", "cancelled"].includes(
          previous.report.verification.execution_state ?? "",
        )
      )
        return jsonError({ task_id, status: "previous_run_unavailable" });

      if (!reserveTaskDispatch(task_id)) {
        return jsonError({ task_id, status: "dispatch_in_progress" });
      }

      const releaseWorkspaceDispatch = acquireManagedWorkspaceDispatch(task.workspaceId);
      if (!releaseWorkspaceDispatch) {
        releaseTaskDispatch(task_id);
        return jsonError({ task_id, status: "workspace_removed", workspace: task.workspace });
      }

      let parsedModel: { providerID: string; modelID: string } | undefined;
      if (model !== undefined) {
        parsedModel = parseModel(model);
        if (!parsedModel) {
          releaseWorkspaceDispatch();
          releaseTaskDispatch(task_id);
          return jsonError({
            task_id,
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
            workspace: task.workspace,
          });
        }
      }

      let provisionalLease: symbol | undefined;
      try {
        const verified = Boolean(expected_changes?.length || checks?.length);
        const lease = task?.directory
          ? await reserveWorkspace(task.directory, verified)
          : undefined;
        if (task?.directory && !lease) return jsonError({ task_id, status: "workspace_busy" });
        provisionalLease = lease;
        let baseline: WorkspaceSnapshot | undefined;
        let baselineError: string | undefined;
        try {
          if (task?.directory)
            baseline = await captureWorkspace(
              task.directory,
              expected_changes?.map((item) => item.path),
            );
        } catch (error) {
          baselineError = error instanceof Error ? error.message : String(error);
        }
        const runId = randomUUID();
        const messageId = createMessageId();
        const startedAt = Date.now();
        const previousState = {
          currentRunId: task.currentRunId,
          createdAt: task.createdAt,
          cancelledAt: task.cancelledAt,
        };
        const run: TaskRunRecord = {
          run_id: runId,
          message_id: messageId,
          startedAt,
          baseline,
          baselineError,
          expectedChanges: expected_changes as ExpectedChange[] | undefined,
          checks: checks as VerificationCheck[] | undefined,
          workspaceLease: lease,
          controller: new AbortController(),
          dispatchState: "dispatching",
        };
        acceptTaskRun(task_id, run);
        provisionalLease = undefined;
        const outcome = await sendPromptAndClassify(() =>
          client.session.promptAsync({
            path: { id: sessionId },
            body: {
              messageID: messageId,
              parts: [{ type: "text", text: prompt }],
              ...(agent ? { agent } : {}),
              ...(parsedModel ? { model: parsedModel } : {}),
            },
          }),
        );
        if (outcome.state === "rejected") {
          rollbackTaskRun(task_id, runId, previousState);
          return jsonError({
            task_id,
            status: "prompt_rejected",
            http_status: outcome.status,
            message: outcome.error,
          });
        }
        run.dispatchState = outcome.state;
        if (outcome.state === "uncertain") run.dispatchError = outcome.error;
        observeRun(task_id, runId);

        return jsonResult({
          task_id,
          session_id: sessionId,
          workspace: task.workspace,
          status: outcome.state === "accepted" ? "pending" : "dispatch_uncertain",
          run_id: runId,
          ...(outcome.state === "uncertain"
            ? {
                dispatch: {
                  state: outcome.state,
                  error: outcome.error,
                  http_status: outcome.status,
                },
              }
            : {}),
        });
      } catch (error) {
        if (provisionalLease) releaseWorkspace(provisionalLease);
        return jsonError({
          task_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          workspace: task.workspace,
        });
      } finally {
        releaseWorkspaceDispatch();
        releaseTaskDispatch(task_id);
      }
    },
  );
}

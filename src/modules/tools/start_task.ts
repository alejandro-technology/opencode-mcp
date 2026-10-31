import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
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
import { clientForServer, sdkResponseError } from "../shared/opencode-client.js";
import {
  registerPermissionSession,
  unregisterPermissionSession,
} from "../shared/permission-scopes.js";
import { externalDirectoryPermission } from "../shared/permissions.js";
import { sendPromptAndClassify } from "../shared/prompt-dispatch.js";
import { observeRun } from "../shared/run-observer.js";
import { getServer } from "../shared/server-registry.js";
import { registerTask, removeTask, type TaskRunRecord } from "../shared/task-registry.js";
import {
  acquireManagedWorkspaceDispatch,
  associateManagedWorkspaceTask,
  createManagedWorkspace,
  registerManagedWorkspaceSession,
  sharedWorkspaceMetadata,
} from "../shared/workspace-manager.js";

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

export function registerOpencodeStartTask(server: McpServer) {
  server.registerTool(
    "opencode_start_task",
    {
      description:
        "Delegate a task to an OpenCode agent: create a session and start the prompt without waiting for it to finish",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to run the task on"),
        directory: z
          .string()
          .optional()
          .describe("Project directory, relative to the server directory unless absolute"),
        workspace_mode: z
          .enum(["shared", "worktree"])
          .default("shared")
          .describe(
            "Use the selected directory directly or create an isolated managed Git worktree",
          ),
        base_ref: z
          .string()
          .optional()
          .describe("Committed Git base for workspace_mode=worktree (default HEAD)"),
        prompt: z.string().describe("Prompt/instructions for the agent"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent name to delegate to (e.g. 'build', 'plan'). Discover available agents with opencode_list_agents. Omit to use the server's default agent",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model override as 'providerID/modelID', copied verbatim from opencode_list_agents output — never guess or construct the id from a model's display name. Overrides the agent's pre-assigned model for this task only. An unknown model is rejected with status 'unknown_model' and the list of available models",
          ),
        expected_changes: z.array(expectedChangeSchema).optional(),
        checks: z.array(checkSchema).optional(),
      },
    },
    async ({
      server_id,
      prompt,
      agent,
      model,
      expected_changes,
      checks,
      directory,
      workspace_mode,
      base_ref,
    }) => {
      const server = getServer(server_id);
      if (!server) {
        return jsonError({ server_id, status: "server_not_found" });
      }

      let parsedModel: { providerID: string; modelID: string } | undefined;
      if (model !== undefined) {
        parsedModel = parseModel(model);
        if (!parsedModel) {
          return jsonError({
            server_id,
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          });
        }
      }

      let provisionalLease: symbol | undefined;
      let workspaceMetadata: ReturnType<typeof sharedWorkspaceMetadata> | undefined;
      let releaseManagedDispatch: (() => void) | undefined;
      try {
        let sourceDirectory: string;
        try {
          sourceDirectory = await realpath(
            resolve(server.directory ?? process.cwd(), directory ?? "."),
          );
          if (!(await stat(sourceDirectory)).isDirectory()) {
            return jsonError({ server_id, status: "invalid_directory", directory });
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            return jsonError({ server_id, status: "invalid_directory", directory });
          }
          throw error;
        }
        if (base_ref !== undefined && workspace_mode !== "worktree") {
          return jsonError({ server_id, status: "base_ref_requires_worktree" });
        }
        workspaceMetadata =
          workspace_mode === "worktree"
            ? await createManagedWorkspace(server_id, sourceDirectory, base_ref)
            : sharedWorkspaceMetadata(sourceDirectory);
        const workspace = workspaceMetadata.execution_directory;
        const workspaceId = workspaceMetadata.workspace_id;
        if (workspaceId) {
          releaseManagedDispatch = acquireManagedWorkspaceDispatch(workspaceId);
          if (!releaseManagedDispatch) {
            return jsonError({
              server_id,
              status: "workspace_unavailable",
              workspace_id: workspaceId,
              workspace: workspaceMetadata,
            });
          }
        }
        const client = clientForServer(server_id, workspace);
        if (!client)
          return jsonError({
            server_id,
            status: "server_not_found",
            ...(workspaceMetadata.managed
              ? { workspace: workspaceMetadata, workspace_id: workspaceId }
              : {}),
          });
        if (parsedModel) {
          const requested = parsedModel;
          // Validate against the server's real model catalog before asynchronous dispatch;
          // a known missing model would otherwise leave a task pending without a useful error.
          let available: Array<{ providerID: string; id: string }> | undefined;
          try {
            const modelsRes = await client.model.list({ location: { directory: workspace } });
            available = modelsRes.data ?? [];
          } catch {
            // The provider catalog may be temporarily unavailable; prompt dispatch remains async.
          }
          if (
            available &&
            !available.some(
              (item) => item.providerID === requested.providerID && item.id === requested.modelID,
            )
          ) {
            return jsonError({
              server_id,
              status: "unknown_model",
              model,
              ...(workspaceMetadata.managed
                ? { workspace: workspaceMetadata, workspace_id: workspaceId }
                : {}),
              message:
                "model is not available on this server; copy an exact 'providerID/modelID' from opencode_list_agents instead of guessing",
              available_models: available.map((item) => `${item.providerID}/${item.id}`),
            });
          }
        }

        const agents = await client.agent.list({ location: { directory: workspace } });
        const configEntries = await client.config.get({ location: { directory: workspace } });
        const configuredAgent = [...configEntries]
          .reverse()
          .filter((entry) => entry.type === "document")
          .map((entry) => entry.info.default_agent)
          .find((item): item is string => Boolean(item));
        const selectedAgent =
          agent ??
          configuredAgent ??
          (agents.data.some((item) => item.id === "build")
            ? "build"
            : agents.data.find((item) => item.mode === "primary")?.id);
        if (selectedAgent && !agents.data.some((item) => item.id === selectedAgent)) {
          return jsonError({
            server_id,
            status: agent ? "unknown_agent" : "default_agent_unavailable",
            agent: selectedAgent,
            available_agents: agents.data.map((item) => item.id),
          });
        }
        const selectedAgentInfo = agents.data.find((item) => item.id === selectedAgent);
        const defaultModel = selectedAgentInfo?.model
          ? { ...selectedAgentInfo.model }
          : (await client.model.default({ location: { directory: workspace } })).data;
        const created = await client.session.create({
          title: prompt.slice(0, 60),
          location: { directory: workspace },
          ...(selectedAgent ? { agent: selectedAgent } : {}),
          ...(parsedModel
            ? { model: { providerID: parsedModel.providerID, id: parsedModel.modelID } }
            : {}),
          permissions: [externalDirectoryPermission(server.permissionPolicy ?? "read-only")],
        });
        if (sdkResponseError(created)) throw sdkResponseError(created);
        const sessionId = created.id;
        if (!sessionId) {
          return jsonError({
            server_id,
            status: "error",
            message: "failed to create session",
            ...(workspaceMetadata?.managed
              ? { workspace: workspaceMetadata, workspace_id: workspaceMetadata.workspace_id }
              : {}),
          });
        }

        if (workspaceId) {
          if (!registerManagedWorkspaceSession(workspaceId, sessionId)) {
            return jsonError({
              server_id,
              status: "workspace_unavailable",
              workspace_id: workspaceId,
              workspace: workspaceMetadata,
            });
          }
        } else {
          registerPermissionSession(server_id, sourceDirectory, sessionId, server.permissionPolicy);
        }
        const verified = Boolean(expected_changes?.length || checks?.length);
        const lease = await reserveWorkspace(workspace, verified);
        if (!lease) {
          unregisterPermissionSession(server_id, workspace, sessionId);
          return jsonError({
            server_id,
            status: "workspace_busy",
            workspace: workspaceMetadata,
            workspace_id: workspaceId,
          });
        }
        provisionalLease = lease;
        let baseline: WorkspaceSnapshot | undefined;
        let baselineError: string | undefined;
        try {
          baseline = await captureWorkspace(
            workspace,
            expected_changes?.map((item) => item.path),
          );
        } catch (error) {
          baselineError = error instanceof Error ? error.message : String(error);
        }

        const taskId = randomUUID();
        const runId = randomUUID();
        const messageId = createMessageId();
        const startedAt = Date.now();
        const run: TaskRunRecord = {
          run_id: runId,
          message_id: messageId,
          startedAt,
          expectedChanges: expected_changes as ExpectedChange[] | undefined,
          checks: checks as VerificationCheck[] | undefined,
          baseline,
          baselineError,
          workspaceLease: lease,
          controller: new AbortController(),
          dispatchState: "dispatching" as const,
        };
        registerTask({
          taskId,
          serverId: server_id,
          sessionId,
          directory: workspace,
          agent: created.agent ?? selectedAgent,
          model: created.model
            ? { ...created.model }
            : defaultModel
              ? { ...defaultModel }
              : undefined,
          workspace: workspaceMetadata,
          workspaceId,
          createdAt: startedAt,
          currentRunId: runId,
          runs: [run],
        });
        provisionalLease = undefined;
        if (workspaceId) associateManagedWorkspaceTask(workspaceId, taskId);

        const outcome = await sendPromptAndClassify(() =>
          client.session.prompt({ sessionID: sessionId, id: messageId, text: prompt }),
        );
        if (outcome.state === "rejected") {
          if (workspaceId) {
            run.dispatchState = "rejected";
            run.executionState = "failed";
            run.reportReady = true;
            run.result = {
              task_id: taskId,
              run_id: runId,
              status: "failed",
              result: null,
              error: outcome.error,
            };
            releaseWorkspace(lease);
            run.workspaceLease = undefined;
          } else {
            removeTask(taskId);
          }
          unregisterPermissionSession(server_id, workspace, sessionId);
          return jsonError({
            server_id,
            task_id: workspaceId ? taskId : undefined,
            run_id: workspaceId ? runId : undefined,
            status: "prompt_rejected",
            http_status: outcome.status,
            message: outcome.error,
            workspace: workspaceMetadata,
            workspace_id: workspaceMetadata.workspace_id,
          });
        }
        run.dispatchState = outcome.state;
        if (outcome.state === "accepted") {
          const inbox = outcome.response as { id?: unknown } | undefined;
          if (typeof inbox?.id === "string") run.inboxId = inbox.id;
        }
        if (outcome.state === "uncertain") run.dispatchError = outcome.error;
        observeRun(taskId, runId);

        return jsonResult({
          task_id: taskId,
          run_id: runId,
          server_id,
          session_id: sessionId,
          workspace: workspaceMetadata,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
          status: outcome.state === "accepted" ? "pending" : "dispatch_uncertain",
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
          server_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(workspaceMetadata?.managed
            ? { workspace: workspaceMetadata, workspace_id: workspaceMetadata.workspace_id }
            : {}),
        });
      } finally {
        releaseManagedDispatch?.();
      }
    },
  );
}

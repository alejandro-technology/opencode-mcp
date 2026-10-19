import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitWorkspaceError } from "../shared/git-workspace.js";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { getTask, releaseTaskDispatch, reserveTaskDispatch } from "../shared/task-registry.js";
import {
  managedWorkspaceTaskIds,
  releaseManagedWorkspaceCleanup,
  removeManagedWorkspace,
  reserveManagedWorkspaceCleanup,
  workspaceMetadata,
} from "../shared/workspace-manager.js";

export function registerOpencodeCleanupWorkspace(server: McpServer) {
  server.registerTool(
    "opencode_cleanup_workspace",
    {
      description: "Remove a managed Git workspace after its task reports are finalized",
      inputSchema: {
        workspace_id: z.string().describe("Owned workspace_id returned by opencode_start_task"),
        discard_changes: z
          .boolean()
          .optional()
          .describe("Explicitly discard changes inside this owned worktree"),
      },
    },
    async ({ workspace_id, discard_changes = false }) => {
      const initial = workspaceMetadata(workspace_id);
      if (!initial) return jsonError({ workspace_id, status: "workspace_not_found" });
      if (initial.state === "removed") {
        return jsonResult({ workspace_id, status: "removed", workspace: initial });
      }

      const taskIds = managedWorkspaceTaskIds(workspace_id);
      const reserved: string[] = [];
      for (const taskId of taskIds) {
        if (!reserveTaskDispatch(taskId)) {
          for (const held of reserved) releaseTaskDispatch(held);
          return jsonError({ workspace_id, status: "dispatch_in_progress" });
        }
        reserved.push(taskId);
      }

      const cleanup = reserveManagedWorkspaceCleanup(workspace_id);
      if (!cleanup) {
        for (const held of reserved) releaseTaskDispatch(held);
        return jsonError({ workspace_id, status: "workspace_busy" });
      }

      try {
        for (const taskId of taskIds) {
          const task = getTask(taskId);
          if (!task || task.workspaceId !== workspace_id) {
            return jsonError({ workspace_id, status: "workspace_ownership_mismatch" });
          }
          const runs = task.runs ?? [];
          const unfinished = runs.find(
            (run) =>
              !run.reportReady ||
              run.workspaceLease !== undefined ||
              run.dispatchState === "dispatching",
          );
          if (unfinished) {
            return jsonError({
              workspace_id,
              task_id: taskId,
              run_id: unfinished.run_id,
              status: "workspace_task_active",
            });
          }
        }

        await removeManagedWorkspace(workspace_id, discard_changes);
        const removed = workspaceMetadata(workspace_id);
        for (const taskId of taskIds) {
          const task = getTask(taskId);
          if (task && removed) task.workspace = removed;
        }
        return jsonResult({ workspace_id, status: "removed", workspace: removed });
      } catch (error) {
        const status = error instanceof GitWorkspaceError ? error.code : "cleanup_failed";
        return jsonError({
          workspace_id,
          status,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        releaseManagedWorkspaceCleanup(workspace_id);
        for (const taskId of reserved) releaseTaskDispatch(taskId);
      }
    },
  );
}

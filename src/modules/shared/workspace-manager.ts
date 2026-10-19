import {
  createGitWorkspace,
  describeGitWorkspace,
  type GitWorkspace,
  removeGitWorkspace,
} from "./git-workspace.js";
import {
  registerPermissionSession,
  stopPermissionScope,
  unregisterPermissionSession,
} from "./permission-scopes.js";
import { getServer } from "./server-registry.js";

export type WorkspaceMetadata = {
  workspace_id?: string;
  mode: "shared" | "worktree";
  source_directory: string;
  execution_directory: string;
  managed: boolean;
  base_commit?: string;
  source_dirty?: boolean;
  state?: "active" | "removed";
};

type ManagedWorkspaceRecord = {
  handle: GitWorkspace;
  serverId: string;
  taskIds: Set<string>;
  sessionIDs: Set<string>;
  activeDispatches: number;
  state: "active" | "cleaning" | "removed";
};

const workspaces = new Map<string, ManagedWorkspaceRecord>();

export async function createManagedWorkspace(
  serverId: string,
  sourceDirectory: string,
  baseRef?: string,
): Promise<WorkspaceMetadata> {
  const handle = await createGitWorkspace(sourceDirectory, { baseRef });
  workspaces.set(handle.id, {
    handle,
    serverId,
    taskIds: new Set(),
    sessionIDs: new Set(),
    activeDispatches: 0,
    state: "active",
  });
  return metadataForHandle(handle, "active");
}

function metadataForHandle(handle: GitWorkspace, state: "active" | "removed"): WorkspaceMetadata {
  return {
    workspace_id: handle.id,
    mode: "worktree",
    source_directory: handle.sourceDirectory,
    execution_directory: handle.executionDirectory,
    managed: true,
    base_commit: handle.baseCommit,
    source_dirty: handle.sourceDirty,
    state,
  };
}

export function sharedWorkspaceMetadata(directory: string): WorkspaceMetadata {
  return {
    mode: "shared",
    source_directory: directory,
    execution_directory: directory,
    managed: false,
    state: "active",
  };
}

export function workspaceMetadata(workspaceId: string): WorkspaceMetadata | undefined {
  const record = workspaces.get(workspaceId);
  if (!record) return undefined;
  return metadataForHandle(record.handle, record.state === "removed" ? "removed" : "active");
}

export function registerManagedWorkspaceSession(workspaceId: string, sessionId: string): boolean {
  const record = workspaces.get(workspaceId);
  if (record?.state !== "active") return false;
  const server = getServer(record.serverId);
  if (!server) return false;
  describeGitWorkspace(record.handle);
  record.sessionIDs.add(sessionId);
  registerPermissionSession(
    record.serverId,
    record.handle.executionDirectory,
    sessionId,
    server.permissionPolicy,
  );
  return true;
}

export function associateManagedWorkspaceTask(workspaceId: string, taskId: string): boolean {
  const record = workspaces.get(workspaceId);
  if (record?.state !== "active") return false;
  record.taskIds.add(taskId);
  return true;
}

export function managedWorkspaceTaskIds(workspaceId: string): string[] {
  const record = workspaces.get(workspaceId);
  return record ? [...record.taskIds] : [];
}

export function acquireManagedWorkspaceDispatch(
  workspaceId: string | undefined,
): (() => void) | undefined {
  if (!workspaceId) return () => {};
  const record = workspaces.get(workspaceId);
  if (record?.state !== "active") return undefined;
  record.activeDispatches++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.activeDispatches = Math.max(0, record.activeDispatches - 1);
  };
}

export function reserveManagedWorkspaceCleanup(
  workspaceId: string,
): { handle: GitWorkspace; taskIds: string[] } | undefined {
  const record = workspaces.get(workspaceId);
  if (record?.state !== "active" || record.activeDispatches > 0) return undefined;
  record.state = "cleaning";
  return { handle: record.handle, taskIds: [...record.taskIds] };
}

export async function removeManagedWorkspace(
  workspaceId: string,
  discardChanges: boolean,
): Promise<void> {
  const record = workspaces.get(workspaceId);
  if (record?.state !== "cleaning") throw new Error("workspace cleanup lease is not held");
  await removeGitWorkspace(record.handle, { discardChanges });
  for (const sessionId of record.sessionIDs) {
    unregisterPermissionSession(record.serverId, record.handle.executionDirectory, sessionId);
  }
  stopPermissionScope(record.serverId, record.handle.executionDirectory);
  record.state = "removed";
}

export function releaseManagedWorkspaceCleanup(workspaceId: string): void {
  const record = workspaces.get(workspaceId);
  if (record?.state === "cleaning") record.state = "active";
}

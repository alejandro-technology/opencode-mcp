import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { getDb, getInstanceId, getRawDb, withImmediateTx } from "./db/index.js";
import * as schema from "./db/schema.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const handles = new Map<string, { workspace: GitWorkspace; runGit: GitRunner }>();

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export type GitWorkspace = {
  id: string;
  sourceDirectory: string;
  repositoryDirectory: string;
  worktreeDirectory: string;
  executionDirectory: string;
  baseCommit: string;
  sourceDirty: boolean;
  managed: true;
};

export type CreateGitWorkspaceOptions = {
  baseRef?: string;
  serverId?: string;
  /** Internal test seam; production callers should use the managed cache parent. */
  workspaceParent?: string;
  /** Internal command boundary for deterministic failure-path tests. */
  gitRunner?: GitRunner;
  /** Internal executable override for testing missing-Git behavior. */
  gitExecutable?: string;
};

export type RemoveGitWorkspaceOptions = { discardChanges?: boolean };
export type GitWorkspaceErrorCode =
  | "git_unavailable"
  | "not_repository"
  | "invalid_base_ref"
  | "missing_execution_directory"
  | "provision_failed"
  | "not_owned"
  | "tampered"
  | "dirty"
  | "remove_failed";

export class GitWorkspaceError extends Error {
  constructor(
    public readonly code: GitWorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

function gitRunner(executable: string): GitRunner {
  return async (cwd, args) => {
    try {
      const result = await execFileAsync(executable, args, {
        cwd,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return result.stdout.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GitWorkspaceError("git_unavailable", "Git executable is unavailable");
      }
      throw error;
    }
  };
}

async function canonical(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function isDirty(directory: string, command: GitRunner): Promise<boolean> {
  return (await command(directory, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
}

function managedParent(): string {
  return (
    process.env.OPENCODE_MCP_WORKSPACE_DIR ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-mcp", "workspaces")
  );
}

export async function createGitWorkspace(
  sourcePath: string,
  options: CreateGitWorkspaceOptions = {},
): Promise<GitWorkspace> {
  const command = options.gitRunner ?? gitRunner(options.gitExecutable ?? "git");
  let sourceDirectory: string;
  let repositoryDirectory: string;
  try {
    sourceDirectory = await canonical(sourcePath);
    repositoryDirectory = await canonical(
      await command(sourceDirectory, ["rev-parse", "--show-toplevel"]),
    );
  } catch (error) {
    if (error instanceof GitWorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GitWorkspaceError(
        "not_repository",
        "Source directory does not exist or is not a Git repository",
      );
    }
    throw new GitWorkspaceError(
      "not_repository",
      "Source directory is not inside a Git repository",
    );
  }

  const baseRef = options.baseRef ?? "HEAD";
  let baseCommit: string;
  try {
    baseCommit = await command(repositoryDirectory, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ]);
  } catch {
    throw new GitWorkspaceError("invalid_base_ref", `Base ref is not a valid commit: ${baseRef}`);
  }

  const relativeExecutionDirectory = relative(repositoryDirectory, sourceDirectory);
  if (
    relativeExecutionDirectory &&
    !(await command(repositoryDirectory, [
      "ls-tree",
      "--full-tree",
      baseCommit,
      "--",
      relativeExecutionDirectory,
    ]))
  ) {
    throw new GitWorkspaceError(
      "missing_execution_directory",
      `The selected base does not contain the requested source directory: ${relativeExecutionDirectory}`,
    );
  }

  let sourceDirty: boolean;
  let parentCanonical: string;
  try {
    sourceDirty = await isDirty(repositoryDirectory, command);
    const parent = resolve(options.workspaceParent ?? managedParent());
    await mkdir(parent, { recursive: true, mode: 0o700 });
    parentCanonical = await canonical(parent);
  } catch (error) {
    throw new GitWorkspaceError(
      "provision_failed",
      `Unable to prepare managed workspace: ${String(error)}`,
    );
  }
  const worktreeDirectory = join(parentCanonical, `workspace-${randomUUID()}`);
  const executionDirectory = join(worktreeDirectory, relativeExecutionDirectory);
  try {
    await command(repositoryDirectory, [
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      "--",
      worktreeDirectory,
      baseCommit,
    ]);
    const id = randomUUID();
    const workspace: GitWorkspace = {
      id,
      sourceDirectory,
      repositoryDirectory,
      worktreeDirectory: await canonical(worktreeDirectory),
      executionDirectory: await canonical(executionDirectory),
      baseCommit,
      sourceDirty,
      managed: true,
    };
    handles.set(id, { workspace, runGit: command });
    try {
      withImmediateTx(() => {
        getRawDb()
          .prepare(
            "INSERT INTO workspaces (workspace_id, server_id, source_directory, repository_directory, worktree_directory, execution_directory, base_commit, source_dirty, state, owner_instance_id, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL) ON CONFLICT(workspace_id) DO UPDATE SET server_id=excluded.server_id, source_directory=excluded.source_directory, repository_directory=excluded.repository_directory, worktree_directory=excluded.worktree_directory, execution_directory=excluded.execution_directory, base_commit=excluded.base_commit, source_dirty=excluded.source_dirty, state='active', owner_instance_id=excluded.owner_instance_id, created_at=excluded.created_at, removed_at=NULL",
          )
          .run(
            workspace.id,
            options.serverId ?? "",
            workspace.sourceDirectory,
            workspace.repositoryDirectory,
            workspace.worktreeDirectory,
            workspace.executionDirectory,
            workspace.baseCommit,
            workspace.sourceDirty ? 1 : 0,
            getInstanceId(),
            Date.now(),
          );
      });
    } catch (error) {
      handles.delete(id);
      throw new GitWorkspaceError(
        "provision_failed",
        `Unable to persist managed workspace: ${String(error)}`,
      );
    }
    return workspace;
  } catch (error) {
    // Leave any partial worktree for explicit inspection; never force-clean unknown state.
    throw new GitWorkspaceError(
      "provision_failed",
      `Unable to create managed worktree: ${String(error)}`,
    );
  }
}

export function hydrateGitWorkspace(id: string): GitWorkspace | undefined {
  let row: (typeof schema.workspaces)["$inferSelect"] | undefined;
  try {
    row = getDb()
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.workspaceId, id))
      .all()[0];
  } catch {
    return undefined;
  }
  if (!row || row.state === "removed") return undefined;
  const workspace: GitWorkspace = {
    id: row.workspaceId,
    sourceDirectory: row.sourceDirectory,
    repositoryDirectory: row.repositoryDirectory,
    worktreeDirectory: row.worktreeDirectory,
    executionDirectory: row.executionDirectory,
    baseCommit: row.baseCommit,
    sourceDirty: row.sourceDirty,
    managed: true,
  };
  handles.set(id, { workspace, runGit: gitRunner("git") });
  return { ...workspace };
}

export function getGitWorkspaceById(id: string): GitWorkspace | undefined {
  const existing = handles.get(id);
  if (existing) return { ...existing.workspace };
  return hydrateGitWorkspace(id);
}

export function describeGitWorkspace(handle: GitWorkspace): GitWorkspace {
  const hadRecord = handles.has(handle.id);
  let record = handles.get(handle.id);
  if (!record) {
    hydrateGitWorkspace(handle.id);
    record = handles.get(handle.id);
  }
  if (!record) {
    throw new GitWorkspaceError("not_owned", "Workspace handle is not owned by this process");
  }
  if (hadRecord && record.workspace !== handle) {
    throw new GitWorkspaceError("not_owned", "Workspace handle is not owned by this process");
  }
  return { ...record.workspace };
}

export async function removeGitWorkspace(
  handle: GitWorkspace,
  options: RemoveGitWorkspaceOptions = {},
): Promise<{ status: "removed" }> {
  const hadRecord = handles.has(handle.id);
  let record = handles.get(handle.id);
  if (!record) {
    hydrateGitWorkspace(handle.id);
    record = handles.get(handle.id);
  }
  if (!record) {
    throw new GitWorkspaceError("not_owned", "Workspace handle is not owned by this process");
  }
  if (hadRecord && record.workspace !== handle) {
    throw new GitWorkspaceError("not_owned", "Workspace handle is not owned by this process");
  }
  const owned = record.workspace;
  const command = record.runGit;
  try {
    if ((await canonical(owned.sourceDirectory)) === owned.worktreeDirectory) {
      throw new GitWorkspaceError("tampered", "Worktree path aliases the source directory");
    }
    let canonicalRepository: string;
    let canonicalWorktree: string;
    try {
      canonicalRepository = await canonical(owned.repositoryDirectory);
      canonicalWorktree = await canonical(owned.worktreeDirectory);
    } catch {
      throw new GitWorkspaceError("tampered", "Workspace root or source repository is missing");
    }
    if (
      canonicalRepository !== owned.repositoryDirectory ||
      canonicalWorktree !== owned.worktreeDirectory
    ) {
      throw new GitWorkspaceError("tampered", "Workspace paths changed since provisioning");
    }
    const common = await command(owned.worktreeDirectory, ["rev-parse", "--git-common-dir"]);
    const sourceCommon = await command(owned.repositoryDirectory, [
      "rev-parse",
      "--git-common-dir",
    ]);
    const canonicalCommon = async (cwd: string, value: string) => canonical(resolve(cwd, value));
    if (
      (await canonicalCommon(owned.worktreeDirectory, common)) !==
      (await canonicalCommon(owned.repositoryDirectory, sourceCommon))
    ) {
      throw new GitWorkspaceError(
        "tampered",
        "Worktree Git metadata no longer matches its source repository",
      );
    }
    if (!options.discardChanges && (await isDirty(owned.worktreeDirectory, command))) {
      throw new GitWorkspaceError("dirty", "Worktree has uncommitted or untracked changes");
    }
    await command(owned.repositoryDirectory, [
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "remove",
      ...(options.discardChanges ? ["--force"] : []),
      "--",
      owned.worktreeDirectory,
    ]);
    handles.delete(owned.id);
    try {
      withImmediateTx(() => {
        getRawDb()
          .prepare("UPDATE workspaces SET state='removed', removed_at=? WHERE workspace_id=?")
          .run(Date.now(), owned.id);
      });
    } catch {
      // Best-effort durable update; git removal already succeeded.
    }
    return { status: "removed" };
  } catch (error) {
    try {
      withImmediateTx(() => {
        getRawDb()
          .prepare("UPDATE workspaces SET state='active' WHERE workspace_id=?")
          .run(owned.id);
      });
    } catch {
      // Best-effort reset.
    }
    if (error instanceof GitWorkspaceError) throw error;
    throw new GitWorkspaceError(
      "remove_failed",
      `Unable to safely remove worktree: ${String(error)}`,
    );
  }
}

export function resetGitWorkspaceForTests(): void {
  handles.clear();
}

export const resetGitWorkspacesForTests = resetGitWorkspaceForTests;

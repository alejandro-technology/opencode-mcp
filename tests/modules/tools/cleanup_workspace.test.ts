import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServer, removeServer } from "../../../src/modules/shared/server-registry.js";
import {
  registerTask,
  releaseTaskDispatch,
  removeTask,
  reserveTaskDispatch,
} from "../../../src/modules/shared/task-registry.js";
import {
  acquireManagedWorkspaceDispatch,
  associateManagedWorkspaceTask,
  createManagedWorkspace,
} from "../../../src/modules/shared/workspace-manager.js";
import { registerOpencodeCleanupWorkspace } from "../../../src/modules/tools/cleanup_workspace.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const roots: string[] = [];
let sequence = 0;

async function setup(reportReady = true) {
  const root = await mkdtemp(join(tmpdir(), "cleanup-workspace-test-"));
  roots.push(root);
  const repository = join(root, "repo");
  const source = join(repository, "package");
  await mkdir(source, { recursive: true });
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(source, "source.txt"), "unchanged\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const serverId = `server-${++sequence}`;
  const taskId = `task-${sequence}`;
  registerServer({ serverId, baseUrl: "http://127.0.0.1:4096", directory: root, close: () => {} });
  const workspace = await createManagedWorkspace(serverId, source);
  const workspaceId = workspace.workspace_id;
  if (!workspaceId) throw new Error("managed workspace id was not returned");
  associateManagedWorkspaceTask(workspaceId, taskId);
  registerTask({
    taskId,
    serverId,
    sessionId: `session-${sequence}`,
    directory: workspace.execution_directory,
    workspace,
    workspaceId,
    currentRunId: `run-${sequence}`,
    runs: [
      {
        run_id: `run-${sequence}`,
        message_id: `msg-${sequence}`,
        startedAt: Date.now(),
        executionState: "completed",
        reportReady,
        dispatchState: "accepted",
      },
    ],
  });
  const fake = createFakeMcpServer();
  registerOpencodeCleanupWorkspace(fake.server);
  return { root, source, workspace, workspaceId, taskId, handler: fake.getHandler() };
}

afterEach(async () => {
  for (let index = 1; index <= sequence; index++) {
    removeTask(`task-${index}`);
    removeServer(`server-${index}`);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function payload(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("opencode_cleanup_workspace", () => {
  it("rejects unknown, dispatching, and unfinished workspace tasks", async () => {
    const { handler, workspaceId, taskId } = await setup(false);
    expect(payload(await handler({ workspace_id: "foreign" })).status).toBe("workspace_not_found");

    reserveTaskDispatch(taskId);
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe(
      "dispatch_in_progress",
    );
    releaseTaskDispatch(taskId);

    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe(
      "workspace_task_active",
    );
  });

  it("holds a whole-workspace cleanup reservation against new runs", async () => {
    const { handler, workspaceId } = await setup();
    const release = acquireManagedWorkspaceDispatch(workspaceId);
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe("workspace_busy");
    release?.();
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe("removed");
  });

  it("releases earlier task reservations when a later task is already dispatching", async () => {
    const { handler, workspaceId, taskId } = await setup();
    associateManagedWorkspaceTask(workspaceId, "held-task");
    reserveTaskDispatch("held-task");
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe(
      "dispatch_in_progress",
    );
    expect(reserveTaskDispatch(taskId)).toBe(true);
    releaseTaskDispatch(taskId);
    releaseTaskDispatch("held-task");
  });

  it("cleans an owned pre-dispatch workspace without task records", async () => {
    const root = await mkdtemp(join(tmpdir(), "cleanup-unassigned-workspace-"));
    roots.push(root);
    const repository = join(root, "repo");
    const source = join(repository, "app");
    await mkdir(source, { recursive: true });
    execFileSync("git", ["init", "-q", repository]);
    await writeFile(join(source, "source.txt"), "base\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ]);
    const serverId = `server-${++sequence}`;
    registerServer({
      serverId,
      baseUrl: "http://127.0.0.1:4096",
      directory: root,
      close: () => {},
    });
    const workspace = await createManagedWorkspace(serverId, source);
    const fake = createFakeMcpServer();
    registerOpencodeCleanupWorkspace(fake.server);
    expect(payload(await fake.getHandler()({ workspace_id: workspace.workspace_id })).status).toBe(
      "removed",
    );
  });

  it("refuses dirty cleanup by default and discards only the owned worktree when explicit", async () => {
    const { handler, workspaceId, taskId, workspace, source } = await setup();
    await writeFile(join(workspace.execution_directory, "new.txt"), "owned change\n");
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe("dirty");
    expect(await readFile(join(source, "source.txt"), "utf8")).toBe("unchanged\n");

    const removed = payload(await handler({ workspace_id: workspaceId, discard_changes: true }));
    expect(removed).toMatchObject({
      status: "removed",
      workspace: { state: "removed", managed: true },
    });
    const task = (await import("../../../src/modules/shared/task-registry.js")).getTask(taskId);
    expect(task?.workspace?.state).toBe("removed");
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe("removed");
  });

  it("does not remove a workspace when its task ownership metadata no longer agrees", async () => {
    const { handler, workspaceId, taskId } = await setup();
    const registry = await import("../../../src/modules/shared/task-registry.js");
    const task = registry.getTask(taskId);
    if (!task) throw new Error("cleanup fixture task was not registered");
    task.workspaceId = "other-id";
    expect(payload(await handler({ workspace_id: workspaceId })).status).toBe(
      "workspace_ownership_mismatch",
    );
    task.workspaceId = workspaceId;
    expect(
      payload(await handler({ workspace_id: workspaceId, discard_changes: true })).status,
    ).toBe("removed");
  });

  it("rejects missing tasks and pending dispatch/check leases even when other runs are finalized", async () => {
    const missingTask = await setup();
    removeTask(missingTask.taskId);
    expect(
      payload(await missingTask.handler({ workspace_id: missingTask.workspaceId })).status,
    ).toBe("workspace_ownership_mismatch");

    const pendingCheck = await setup();
    const task = (await import("../../../src/modules/shared/task-registry.js")).getTask(
      pendingCheck.taskId,
    );
    const run = task?.runs?.[0];
    if (!run) throw new Error("cleanup fixture run was not registered");
    run.reportReady = true;
    run.workspaceLease = Symbol("active report lease");
    expect(
      payload(await pendingCheck.handler({ workspace_id: pendingCheck.workspaceId })).status,
    ).toBe("workspace_task_active");
    run.workspaceLease = undefined;
    run.dispatchState = "dispatching";
    expect(
      payload(await pendingCheck.handler({ workspace_id: pendingCheck.workspaceId })).status,
    ).toBe("workspace_task_active");
    run.dispatchState = "uncertain";
    expect(
      payload(await pendingCheck.handler({ workspace_id: pendingCheck.workspaceId })).status,
    ).toBe("workspace_task_active");
    task.runs = undefined;
    expect(
      payload(await pendingCheck.handler({ workspace_id: pendingCheck.workspaceId })).status,
    ).toBe("removed");
  });

  it("converts non-Git removal exceptions into useful cleanup errors", async () => {
    const managerPath = "../../../src/modules/shared/workspace-manager.js";
    const metadata = {
      workspace_id: "mock-workspace",
      mode: "worktree",
      source_directory: "/src",
      execution_directory: "/work",
      managed: true,
      state: "active",
    };
    vi.doMock(managerPath, () => ({
      managedWorkspaceTaskIds: () => ["mock-task"],
      releaseManagedWorkspaceCleanup: vi.fn(),
      removeManagedWorkspace: vi
        .fn()
        .mockRejectedValueOnce(new Error("cleanup I/O failure"))
        .mockRejectedValueOnce("raw cleanup failure"),
      reserveManagedWorkspaceCleanup: () => ({ handle: {}, taskIds: [] }),
      workspaceMetadata: vi
        .fn()
        .mockReturnValueOnce(metadata)
        .mockReturnValueOnce(metadata)
        .mockReturnValueOnce(metadata)
        .mockReturnValueOnce(undefined),
    }));
    vi.resetModules();
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    tasks.registerTask({
      taskId: "mock-task",
      serverId: "mock-server",
      sessionId: "mock-session",
      workspaceId: "mock-workspace",
      workspace: metadata,
      runs: [],
    });
    const tool = await import("../../../src/modules/tools/cleanup_workspace.js");
    const fake = createFakeMcpServer();
    tool.registerOpencodeCleanupWorkspace(fake.server);
    const handler = fake.getHandler();
    expect(payload(await handler({ workspace_id: "mock-workspace" }))).toMatchObject({
      status: "cleanup_failed",
      message: "cleanup I/O failure",
    });
    expect(payload(await handler({ workspace_id: "mock-workspace" }))).toMatchObject({
      status: "cleanup_failed",
      message: "raw cleanup failure",
    });
    expect(payload(await handler({ workspace_id: "mock-workspace" })).status).toBe("removed");
    expect(tasks.getTask("mock-task")?.workspace).toEqual(metadata);
    vi.doUnmock(managerPath);
    vi.resetModules();
  });
});

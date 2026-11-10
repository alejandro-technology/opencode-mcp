import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRawDb, resetDbForTests } from "../../../src/modules/shared/db/index.js";
import {
  releaseWorkspace,
  reserveWorkspace,
} from "../../../src/modules/shared/execution-report.js";
import {
  acceptTaskRun,
  allTasks,
  getTask,
  markTaskCancelled,
  registerTask,
  releaseTaskDispatch,
  removeTask,
  reserveTaskDispatch,
  resetTaskRegistryForTests,
  rollbackTaskRun,
  snapshotTaskDispatch,
  type TaskRecord,
  tasksForServer,
} from "../../../src/modules/shared/task-registry.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    serverId: "srv-1",
    sessionId: "session-1",
    ...overrides,
  };
}

describe("task-registry", () => {
  it("registers and retrieves a task", () => {
    const task = makeTask();
    registerTask(task);
    expect(getTask("task-1")).toBe(task);
  });

  it("returns undefined for an unknown task id", () => {
    expect(getTask("missing-task")).toBeUndefined();
  });

  it("removes a registered task", () => {
    const task = makeTask({ taskId: "task-2" });
    registerTask(task);
    removeTask("task-2");
    expect(getTask("task-2")).toBeUndefined();
  });

  it("aborts child checks and releases every run lease when removing a task", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "task-removal-"));
    const lease = await reserveWorkspace(directory, true);
    const controller = new AbortController();
    registerTask({
      ...makeTask({ taskId: "task-with-run-resource" }),
      currentRunId: "run-1",
      runs: [
        {
          run_id: "run-1",
          message_id: "msg-1",
          startedAt: 1,
          workspaceLease: lease,
          controller,
        },
      ],
    });
    removeTask("task-with-run-resource");
    expect(controller.signal.aborted).toBe(true);
    const afterRemoval = await reserveWorkspace(directory, true);
    expect(afterRemoval).toBeDefined();
    if (!afterRemoval) throw new Error("expected workspace lease after task removal");
    releaseWorkspace(afterRemoval);
    await rm(directory, { recursive: true, force: true });
  });

  it("removes a task whose run history was cleared", () => {
    const task = makeTask({ taskId: "task-without-history" });
    registerTask(task);
    task.runs = undefined;
    removeTask("task-without-history");
    expect(getTask("task-without-history")).toBeUndefined();
  });

  it("reserves dispatches once and updates run metadata only after acceptance", () => {
    registerTask(makeTask({ taskId: "dispatch", cancelledAt: 1 }));
    expect(reserveTaskDispatch("dispatch")).toBe(true);
    expect(reserveTaskDispatch("dispatch")).toBe(false);
    releaseTaskDispatch("dispatch");
    const run = { run_id: "r1", message_id: "m1", startedAt: 9 };
    acceptTaskRun("dispatch", run);
    expect(getTask("dispatch")).toMatchObject({
      currentRunId: "r1",
      createdAt: 9,
      cancelledAt: undefined,
      runs: [run],
      dispatching: false,
    });
    removeTask("dispatch");
  });

  it("safely handles dispatch operations for unknown tasks", () => {
    expect(reserveTaskDispatch("unknown")).toBe(true);
    releaseTaskDispatch("unknown");
    acceptTaskRun("unknown", { run_id: "r", message_id: "m", startedAt: 1 });
    expect(snapshotTaskDispatch("unknown")).toBeUndefined();
    expect(() => rollbackTaskRun("unknown", "r", undefined)).not.toThrow();
  });

  it("rolls back a provisional run and restores previous task metadata", () => {
    const controller = new AbortController();
    registerTask({
      ...makeTask({ taskId: "rollback", currentRunId: "new", createdAt: 2 }),
      cancelledAt: undefined,
      runs: [{ run_id: "new", message_id: "msg-new", startedAt: 2, controller }],
    });
    expect(snapshotTaskDispatch("rollback")).toEqual({
      currentRunId: "new",
      createdAt: 2,
      cancelledAt: undefined,
    });
    rollbackTaskRun("rollback", "new", {
      currentRunId: "old",
      createdAt: 1,
      cancelledAt: 77,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(getTask("rollback")).toMatchObject({
      currentRunId: "old",
      createdAt: 1,
      cancelledAt: 77,
      runs: [],
    });
    removeTask("rollback");
  });

  it("rolls back cleanly without a matching run, lease, or history array", () => {
    const task = makeTask({ taskId: "rollback-missing", createdAt: 3, cancelledAt: 4 });
    registerTask(task);
    task.runs = undefined;
    rollbackTaskRun("rollback-missing", "not-present", undefined);
    expect(task.runs).toEqual([]);
    expect(task.currentRunId).toBeUndefined();
    expect(task.createdAt).toBeUndefined();
    expect(task.cancelledAt).toBeUndefined();
    removeTask("rollback-missing");
  });
});

describe("markTaskCancelled", () => {
  it("stamps the record with the given time", () => {
    registerTask({
      taskId: "t-cancel",
      serverId: "srv",
      sessionId: "s",
      currentRunId: "r",
      runs: [{ run_id: "r", message_id: "m", startedAt: 1 }],
    });
    markTaskCancelled("t-cancel", 1234);
    expect(getTask("t-cancel")?.cancelledAt).toBe(1234);
    expect(getTask("t-cancel")?.runs?.[0].cancelledAt).toBe(1234);
    removeTask("t-cancel");
  });

  it("defaults to now when no time is given", () => {
    registerTask({ taskId: "t-cancel", serverId: "srv", sessionId: "s" });
    markTaskCancelled("t-cancel");
    expect(getTask("t-cancel")?.cancelledAt).toBeTypeOf("number");
    removeTask("t-cancel");
  });

  it("is a no-op for an unknown task id", () => {
    expect(() => markTaskCancelled("nope")).not.toThrow();
    expect(getTask("nope")).toBeUndefined();
  });
});

describe("durable dispatch leases", () => {
  it("claims once, reaps dead owners, and honors live foreign owners", () => {
    registerTask({ taskId: "lease", serverId: "srv", sessionId: "sess" });
    expect(reserveTaskDispatch("lease")).toBe(true);
    expect(reserveTaskDispatch("lease")).toBe(false);

    resetTaskRegistryForTests();
    expect(reserveTaskDispatch("lease")).toBe(false);

    const raw = getRawDb();
    const now = Date.now();
    raw
      .prepare(
        "INSERT INTO mcp_instances (instance_id, pid, process_started_at, heartbeat_at, stopped_at, version) VALUES (?, ?, ?, ?, NULL, ?)",
      )
      .run("live-instance", process.pid, now, now, "test");
    raw
      .prepare(
        "UPDATE task_dispatch_leases SET owner_instance_id = ?, owner_pid = ? WHERE task_id = ?",
      )
      .run("live-instance", process.pid, "lease");
    expect(reserveTaskDispatch("lease")).toBe(false);

    raw
      .prepare(
        "UPDATE task_dispatch_leases SET owner_instance_id = ?, owner_pid = ? WHERE task_id = ?",
      )
      .run("ghost-instance", process.pid, "lease");
    expect(reserveTaskDispatch("lease")).toBe(false);

    raw
      .prepare(
        "UPDATE task_dispatch_leases SET owner_instance_id = ?, owner_pid = ? WHERE task_id = ?",
      )
      .run("dead-instance", 2_147_483_647, "lease");
    expect(reserveTaskDispatch("lease")).toBe(true);
    releaseTaskDispatch("lease");
    removeTask("lease");
  });

  it("protects a live lease and a dispatching task from removal", () => {
    registerTask({ taskId: "lease-task", serverId: "srv", sessionId: "sess" });
    expect(reserveTaskDispatch("lease-task")).toBe(true);
    removeTask("lease-task");
    expect(getTask("lease-task")).toBeDefined();
    releaseTaskDispatch("lease-task");
    removeTask("lease-task");
    expect(getTask("lease-task")).toBeUndefined();

    expect(reserveTaskDispatch("lease-absent")).toBe(true);
    removeTask("lease-absent");
    const raw = getRawDb();
    expect(
      raw
        .prepare("SELECT COUNT(*) AS count FROM task_dispatch_leases WHERE task_id = ?")
        .get("lease-absent"),
    ).toEqual({ count: 1 });
    releaseTaskDispatch("lease-absent");
  });

  it("retires a task row held by a foreign live lease without aborting it", () => {
    registerTask({ taskId: "foreign", serverId: "srv", sessionId: "sess" });
    const raw = getRawDb();
    raw
      .prepare(
        "INSERT INTO task_dispatch_leases (task_id, owner_instance_id, owner_pid, acquired_at) VALUES (?, ?, ?, ?)",
      )
      .run("foreign", "other-instance", process.pid, Date.now());
    resetTaskRegistryForTests();
    removeTask("foreign");
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?").get("foreign"),
    ).toEqual({ count: 1 });
    raw.prepare("DELETE FROM task_dispatch_leases WHERE task_id = ?").run("foreign");
    removeTask("foreign");
    expect(getTask("foreign")).toBeUndefined();
  });
});

describe("durable task state", () => {
  let directory: string;

  beforeEach(async () => {
    resetTaskRegistryForTests();
    resetDbForTests();
    directory = await mkdtemp(path.join(os.tmpdir(), "task-registry-durable-"));
    process.env.OPENCODE_MCP_HISTORY_DB = path.join(directory, "history.sqlite");
  });

  afterEach(async () => {
    resetTaskRegistryForTests();
    resetDbForTests();
    process.env.OPENCODE_MCP_HISTORY_DB = ":memory:";
    resetDbForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it("rehydrates a fully populated task, run, report, usage, and baseline after restart", () => {
    const report = {
      changes: [
        { path: "a.txt", change: "created" as const, evidence: "workspace_delta" as const },
      ],
      verification: { state: "passed" as const, checks: [] },
      diagnostics: [],
      evidence: {
        source: "workspace_delta" as const,
        inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths" as const,
        complete: true,
        errors: [],
        attribution: "uncertain_shared_workspace" as const,
      },
    };
    const usage = {
      captured_at: "2026-10-08T00:00:00.000Z",
      snapshot_kind: "run_finalization" as const,
      report: null,
    };
    registerTask({
      taskId: "durable-full",
      serverId: "srv",
      sessionId: "sess",
      createdAt: 10,
      cancelledAt: 55,
      currentRunId: "run-durable-full",
      directory: "/src",
      workspaceId: "ws",
      workspace: {
        workspace_id: "ws",
        mode: "shared",
        source_directory: "/src",
        execution_directory: "/src",
        managed: false,
        state: "active",
      },
      runs: [
        {
          run_id: "run-durable-full",
          message_id: "msg_durable_full",
          startedAt: 10,
          agentName: "build",
          requestedProviderId: "provider",
          requestedModelId: "model",
          cancelledAt: 55,
          finalizedAt: 20,
          dispatchState: "accepted",
          dispatchError: "dispatch warning",
          executionState: "completed",
          reportReady: true,
          finalizationStarted: true,
          finalizationError: "finalization warning",
          baselineRoot: "/src",
          baselineError: "baseline warning",
          expectedChanges: [{ path: "a.txt", change: "created" }],
          checks: [{ executable: "node", argv: [] }],
          report,
          usage,
          result: {
            task_id: "durable-full",
            run_id: "run-durable-full",
            status: "completed",
            result: "done",
          },
          observerInstanceId: "observer",
          observerGeneration: 2,
          baseline: { root: "/src", files: new Map([["a.txt", "hash-a"]]) },
        },
      ],
    });
    registerTask({ taskId: "durable-idle", serverId: "srv-2", sessionId: "sess" });

    resetTaskRegistryForTests();
    resetDbForTests();

    expect(tasksForServer("srv").map((item) => item.taskId)).toEqual(["durable-full"]);
    expect(allTasks().map((item) => item.taskId)).toEqual(["durable-full", "durable-idle"]);
    const task = getTask("durable-full");
    expect(task).toMatchObject({
      taskId: "durable-full",
      serverId: "srv",
      sessionId: "sess",
      createdAt: 10,
      cancelledAt: 55,
      currentRunId: "run-durable-full",
      directory: "/src",
      workspaceId: "ws",
    });
    expect(task?.workspace?.state).toBe("active");
    expect(task?.runs?.[0]).toMatchObject({
      run_id: "run-durable-full",
      message_id: "msg_durable_full",
      agentName: "build",
      requestedProviderId: "provider",
      requestedModelId: "model",
      cancelledAt: 55,
      finalizedAt: 20,
      dispatchState: "accepted",
      dispatchError: "dispatch warning",
      executionState: "completed",
      reportReady: true,
      finalizationStarted: true,
      finalizationError: "finalization warning",
      baselineRoot: "/src",
      baselineError: "baseline warning",
      observerInstanceId: "observer",
      observerGeneration: 2,
    });
    expect(task?.runs?.[0].report).toEqual(report);
    expect(task?.runs?.[0].usage).toEqual(usage);
    expect(task?.runs?.[0].result?.result).toBe("done");
    expect(task?.runs?.[0].baseline).toBeUndefined();
    expect(tasksForServer("srv").map((item) => item.taskId)).toEqual(["durable-full"]);
    expect(tasksForServer("srv").map((item) => item.taskId)).toEqual(["durable-full"]);
    expect(allTasks().map((item) => item.taskId)).toContain("durable-full");
    expect(allTasks().map((item) => item.taskId)).toContain("durable-full");
  });

  it("rehydrates a minimal task with no optional fields after restart", () => {
    registerTask({
      taskId: "durable-min",
      serverId: "srv",
      sessionId: "sess",
      runs: [{ run_id: "run-durable-min", message_id: "msg_durable_min", startedAt: 4 }],
    });
    resetTaskRegistryForTests();
    resetDbForTests();

    const task = getTask("durable-min");
    expect(task).toMatchObject({ taskId: "durable-min", createdAt: 4 });
    expect(task?.currentRunId).toBeUndefined();
    expect(task?.cancelledAt).toBeUndefined();
    expect(task?.directory).toBeUndefined();
    expect(task?.workspace).toBeUndefined();
    expect(task?.workspaceId).toBeUndefined();
    expect(task?.runs?.[0].agentName).toBeUndefined();
    expect(task?.runs?.[0].dispatchError).toBeUndefined();
    expect(task?.runs?.[0].executionState).toBeUndefined();
    expect(task?.runs?.[0].report).toBeUndefined();
    expect(task?.runs?.[0].usage).toBeUndefined();
    expect(task?.runs?.[0].result).toBeUndefined();
    expect(task?.runs?.[0].observerInstanceId).toBeUndefined();
  });

  it("keeps the first creation timestamp while refreshing the latest run", () => {
    registerTask({
      taskId: "upsert-task",
      serverId: "srv",
      sessionId: "sess",
      createdAt: 100,
      currentRunId: "run-one",
      runs: [{ run_id: "run-one", message_id: "msg_upsert_one", startedAt: 100 }],
    });
    registerTask({
      taskId: "upsert-task",
      serverId: "srv",
      sessionId: "sess",
      createdAt: 200,
      currentRunId: "run-two",
      runs: [{ run_id: "run-two", message_id: "msg_upsert_two", startedAt: 200 }],
    });
    expect(
      getRawDb()
        .prepare("SELECT created_at, started_at, current_run_id FROM tasks WHERE task_id = ?")
        .get("upsert-task"),
    ).toEqual({ created_at: 100, started_at: 200, current_run_id: "run-two" });
    removeTask("upsert-task");
  });

  it("preserves cancellation on both the task and its active run across restart", () => {
    registerTask({
      taskId: "durable-cancel",
      serverId: "srv",
      sessionId: "sess",
      currentRunId: "run-cancel",
      runs: [{ run_id: "run-cancel", message_id: "msg_durable_cancel", startedAt: 1 }],
    });
    markTaskCancelled("durable-cancel", 999);
    resetTaskRegistryForTests();
    resetDbForTests();

    const task = getTask("durable-cancel");
    expect(task?.cancelledAt).toBe(999);
    expect(task?.runs?.[0].cancelledAt).toBe(999);
  });

  it("persists an accepted run, its report, and its result across restart", () => {
    registerTask({
      taskId: "durable-accept",
      serverId: "srv",
      sessionId: "sess",
      currentRunId: "run-first",
      runs: [{ run_id: "run-first", message_id: "msg_durable_first", startedAt: 1 }],
    });
    acceptTaskRun("durable-accept", {
      run_id: "run-second",
      message_id: "msg_durable_second",
      startedAt: 2,
      executionState: "completed",
      reportReady: true,
      report: {
        changes: [],
        verification: { state: "not_requested", checks: [] },
        diagnostics: [],
        evidence: {
          source: "workspace_delta",
          inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
          complete: true,
          errors: [],
          attribution: "uncertain_shared_workspace",
        },
      },
      result: {
        task_id: "durable-accept",
        run_id: "run-second",
        status: "completed",
        result: "accepted output",
      },
    });
    acceptTaskRun("durable-accept", {
      run_id: "run-second",
      message_id: "msg_durable_second",
      startedAt: 2,
      executionState: "completed",
      reportReady: true,
      result: {
        task_id: "durable-accept",
        run_id: "run-second",
        status: "completed",
        result: "accepted output",
      },
    });
    resetTaskRegistryForTests();
    resetDbForTests();

    const task = getTask("durable-accept");
    expect(task?.currentRunId).toBe("run-second");
    expect(task?.runs?.map((run) => run.run_id)).toEqual(["run-first", "run-second"]);
    expect(task?.runs?.[1].reportReady).toBe(true);
    expect(task?.runs?.[1].result?.result).toBe("accepted output");
  });

  it("reclaims a dispatch lease whose owner died across a restart", () => {
    registerTask({ taskId: "restart-lease", serverId: "srv", sessionId: "sess" });
    expect(reserveTaskDispatch("restart-lease")).toBe(true);
    getRawDb()
      .prepare(
        "UPDATE task_dispatch_leases SET owner_instance_id = ?, owner_pid = ? WHERE task_id = ?",
      )
      .run("dead-owner", 2_147_483_647, "restart-lease");
    resetTaskRegistryForTests();
    resetDbForTests();
    expect(reserveTaskDispatch("restart-lease")).toBe(true);
    releaseTaskDispatch("restart-lease");
    removeTask("restart-lease");
  });

  it("rolls back a provisional run even when its task row disappeared", () => {
    registerTask({ taskId: "rollback-row", serverId: "srv", sessionId: "sess", createdAt: 1 });
    getRawDb().prepare("DELETE FROM tasks WHERE task_id = ?").run("rollback-row");
    expect(() => rollbackTaskRun("rollback-row", "absent-run", undefined)).not.toThrow();
    removeTask("rollback-row");
  });
});

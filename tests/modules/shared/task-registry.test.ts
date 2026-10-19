import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseWorkspace,
  reserveWorkspace,
} from "../../../src/modules/shared/execution-report.js";
import {
  acceptTaskRun,
  getTask,
  markTaskCancelled,
  registerTask,
  releaseTaskDispatch,
  removeTask,
  reserveTaskDispatch,
  rollbackTaskRun,
  snapshotTaskDispatch,
  type TaskRecord,
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

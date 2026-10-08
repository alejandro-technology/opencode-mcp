import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  releaseWorkspace,
  reserveWorkspace,
} from "../../../src/modules/shared/execution-report.js";
import {
  getTask,
  registerTask,
  releaseTaskDispatch,
  removeTask,
  reserveTaskDispatch,
} from "../../../src/modules/shared/task-registry.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
}));
vi.mock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));

const { registerOpencodeContinueTask } = await import(
  "../../../src/modules/tools/continue_task.js"
);

describe("opencode_continue_task", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    removeTask("task-1");
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
  });

  afterEach(() => removeTask("task-1"));

  it("returns task_not_found when the task cannot be resolved", async () => {
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "missing", prompt: "keep going" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_id: "missing", status: "task_not_found" }) },
      ],
    });
  });

  it("does not dispatch when the resolved client has no task record", async () => {
    removeTask("task-1");
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "orphaned task" });
    expect(JSON.parse(result.content[0].text).status).toBe("task_not_found");
  });

  it("rejects concurrent dispatch reservations for the same task", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "session-1",
    });
    reserveTaskDispatch("task-1");
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "overlap" });
    expect(JSON.parse(result.content[0].text).status).toBe("dispatch_in_progress");
    releaseTaskDispatch("task-1");
  });

  it("returns invalid_model when model is malformed", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "s1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", prompt: "hi", model: "no-slash" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "task-1",
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          }),
        },
      ],
    });
  });

  it("waits for the current run report before accepting another continuation", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      currentRunId: "old-run",
      runs: [{ run_id: "old-run", message_id: "msg-old", startedAt: 1, reportReady: false }],
    });
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "next" });
    expect(JSON.parse(result.content[0].text).status).toBe("previous_run_reporting");
  });

  it.each([
    [
      "finalization error",
      {
        reportReady: true,
        finalizationError: "capture stopped",
        report: { verification: { execution_state: "completed" } },
      },
    ],
    [
      "unknown execution terminal",
      { reportReady: true, report: { verification: { execution_state: "pending" } } },
    ],
    ["missing execution state", { reportReady: true, report: { verification: {} } }],
  ])("rejects continuation after %s report", async (_label, run) => {
    registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      currentRunId: "old-run",
      runs: [{ run_id: "old-run", message_id: "msg-old", startedAt: 1, ...run }],
    });
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "next" });
    expect(JSON.parse(result.content[0].text).status).toBe("previous_run_unavailable");
  });

  it("rejects a normal continuation while an overlapping verified workspace lease is held", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "continue-lease-"));
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1", directory });
    const lease = await reserveWorkspace(directory, true);
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "ordinary writer" });
    expect(JSON.parse(result.content[0].text).status).toBe("workspace_busy");
    if (!lease) throw new Error("expected verified workspace lease");
    releaseWorkspace(lease);
    await rm(directory, { recursive: true, force: true });
  });

  it("retains baseline capture errors on an accepted continuation run", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "continue-baseline-"));
    await writeFile(path.join(directory, "oversized.bin"), Buffer.alloc(32 * 1024 * 1024 + 1));
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1", directory });
    const promptAsync = vi.fn().mockResolvedValue({});
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({
      task_id: "task-1",
      prompt: "continue despite baseline issue",
      expected_changes: [{ path: "made.txt", change: "created" }],
    });
    expect(JSON.parse(result.content[0].text).status).toBe("pending");
    expect(getTask("task-1")?.runs?.at(-1)?.baselineError).toContain("file inventory exceeded");
    expect(promptAsync).toHaveBeenCalledOnce();
    await rm(directory, { recursive: true, force: true });
  });

  it("retains a provisional workspace lease after ambiguous continuation dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "continue-rollback-"));
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1", directory });
    clientForTaskMock.mockReturnValue({
      client: {
        session: { promptAsync: vi.fn().mockRejectedValue(new Error("dispatch rejected")) },
      },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({
      task_id: "task-1",
      prompt: "rollback lease",
      checks: [{ executable: "node", argv: [] }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      status: "dispatch_uncertain",
      dispatch: { state: "uncertain", error: "dispatch rejected" },
    });
    expect(getTask("task-1")?.runs?.[0].dispatchState).toBe("uncertain");
    expect(await reserveWorkspace(directory, true)).toBeUndefined();
    removeTask("task-1");
    const freshLease = await reserveWorkspace(directory, true);
    expect(freshLease).toBeDefined();
    if (!freshLease) throw new Error("expected workspace lease after rollback");
    releaseWorkspace(freshLease);
    await rm(directory, { recursive: true, force: true });
  });

  it("rolls back a definitively rejected continuation run", async () => {
    clientForTaskMock.mockReturnValue({
      client: {
        session: {
          promptAsync: vi
            .fn()
            .mockResolvedValue({ error: { message: "bad prompt" }, response: { status: 400 } }),
        },
      },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "reject this" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "prompt_rejected",
      http_status: 400,
    });
    expect(getTask("task-1")?.runs).toEqual([]);
    expect(getTask("task-1")?.currentRunId).toBeUndefined();
  });

  it("keeps task metadata if removal is requested during accepted dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "continue-disappeared-"));
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1", directory });
    clientForTaskMock.mockReturnValue({
      client: {
        session: {
          promptAsync: vi.fn().mockImplementation(async () => {
            removeTask("task-1");
            return {};
          }),
        },
      },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", prompt: "registry race" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "pending" });
    expect(getTask("task-1")?.runs).toHaveLength(1);
    removeTask("task-1");
    const lease = await reserveWorkspace(directory, true);
    expect(lease).toBeDefined();
    if (!lease) throw new Error("expected workspace lease after task removal");
    releaseWorkspace(lease);
    await rm(directory, { recursive: true, force: true });
  });

  it("normalizes non-Error baseline capture failures on continuation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "continue-baseline-raw-"));
    vi.doMock("../../../src/modules/shared/execution-report.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../../src/modules/shared/execution-report.js")>()),
      captureWorkspace: vi.fn().mockRejectedValue("raw continuation inventory error"),
    }));
    vi.resetModules();
    const taskRegistry = await import("../../../src/modules/shared/task-registry.js");
    taskRegistry.registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      directory,
    });
    const promptAsync = vi.fn().mockResolvedValue({});
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    const mod = await import("../../../src/modules/tools/continue_task.js");
    const fake = createFakeMcpServer();
    mod.registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({
      task_id: "task-1",
      prompt: "continue with evidence failure",
      expected_changes: [{ path: "made.txt", change: "created" }],
    });
    expect(JSON.parse(result.content[0].text).status).toBe("pending");
    expect(taskRegistry.getTask("task-1")?.runs?.at(-1)?.baselineError).toBe(
      "raw continuation inventory error",
    );
    taskRegistry.removeTask("task-1");
    await rm(directory, { recursive: true, force: true });
    vi.doUnmock("../../../src/modules/shared/execution-report.js");
    vi.resetModules();
  });

  it("releases a provisional lease if run metadata allocation fails before dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "continue-provisional-rollback-"));
    const randomUUID = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("run id allocation failed");
      })
      .mockImplementationOnce(() => {
        throw "raw run id failure";
      });
    vi.doMock("node:crypto", () => ({ randomUUID }));
    vi.resetModules();
    const taskRegistry = await import("../../../src/modules/shared/task-registry.js");
    taskRegistry.registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      directory,
    });
    const promptAsync = vi.fn().mockResolvedValue({});
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    const mod = await import("../../../src/modules/tools/continue_task.js");
    const fake = createFakeMcpServer();
    mod.registerOpencodeContinueTask(fake.server);
    const result = await fake.getHandler()({
      task_id: "task-1",
      prompt: "fails before prompt dispatch",
      checks: [{ executable: process.execPath, argv: [] }],
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "error",
      message: "run id allocation failed",
    });
    expect(promptAsync).not.toHaveBeenCalled();
    const report = await import("../../../src/modules/shared/execution-report.js");
    const lease = await report.reserveWorkspace(directory, true);
    expect(lease).toBeDefined();
    if (!lease) throw new Error("expected rollback to release the provisional lease");
    report.releaseWorkspace(lease);
    taskRegistry.removeTask("task-1");

    taskRegistry.registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
    const noLease = await fake.getHandler()({
      task_id: "task-1",
      prompt: "run id failure without a workspace lease",
    });
    expect(JSON.parse(noLease.content[0].text)).toMatchObject({
      status: "error",
      message: "raw run id failure",
    });
    taskRegistry.removeTask("task-1");
    await rm(directory, { recursive: true, force: true });
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });

  it("returns invalid_model when the slash is at position 0 or end", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn() } },
      sessionId: "s1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", prompt: "hi", model: "/trailing" });
    expect(result).toMatchObject({ isError: true });

    const result2 = await handler({ task_id: "task-1", prompt: "hi", model: "leading/" });
    expect(result2).toMatchObject({ isError: true });
  });

  it("sends the follow-up prompt to the same session with agent and model", async () => {
    const promptAsync = vi.fn().mockResolvedValue({});
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({
      task_id: "task-1",
      prompt: "keep going",
      agent: "build",
      model: "anthropic/claude-sonnet-4",
    });

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: {
        messageID: expect.any(String),
        parts: [{ type: "text", text: "keep going" }],
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      },
    });
    expect(promptAsync.mock.calls[0][0].body.messageID).toMatch(/^msg_/);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      session_id: "session-1",
      status: "pending",
      run_id: expect.any(String),
    });
  });

  it("sends the follow-up prompt without optional agent or model fields", async () => {
    const promptAsync = vi.fn().mockResolvedValue({});
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    await handler({ task_id: "task-1", prompt: "keep going" });

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: { messageID: expect.any(String), parts: [{ type: "text", text: "keep going" }] },
    });
  });

  it("tracks an uncertain dispatch when the SDK throws an Error", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn().mockRejectedValue(new Error("db down")) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", prompt: "hi" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "dispatch_uncertain",
      dispatch: { state: "uncertain", error: "db down" },
    });
  });

  it("tracks an uncertain dispatch when the SDK throws a non-Error value", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn().mockRejectedValue("weird") } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", prompt: "hi" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "dispatch_uncertain",
      dispatch: { state: "uncertain", error: "weird" },
    });
  });

  it("tracks an HTTP error without response status as uncertain", async () => {
    const promptAsync = vi.fn().mockResolvedValue({ error: { message: "HTTP 409" } });
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    removeTask("task-1");
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "session-1",
      cancelledAt: 1,
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);

    const result = await fake.getHandler()({ task_id: "task-1", prompt: "again" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "dispatch_uncertain",
      dispatch: { state: "uncertain", error: "HTTP 409" },
    });
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    expect(getTask("task-1")?.runs).toHaveLength(1);
    removeTask("task-1");
  });

  it("rejects overlapping continuation dispatches and starts a fresh run after acceptance", async () => {
    let accept!: (value: object) => void;
    const promptAsync = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          accept = resolve;
        }),
    );
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync } },
      sessionId: "session-1",
    });
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    tasks.registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "session-1",
      cancelledAt: 1,
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();
    const first = handler({ task_id: "task-1", prompt: "first" });
    const concurrent = await handler({ task_id: "task-1", prompt: "second" });

    expect(concurrent).toMatchObject({ isError: true });
    accept({});
    const accepted = await first;
    const task = getTask("task-1");
    expect(JSON.parse(accepted.content[0].text).run_id).toBe(task?.currentRunId);
    expect(task?.cancelledAt).toBeUndefined();
    expect(task?.runs).toHaveLength(1);
    removeTask("task-1");
  });
});

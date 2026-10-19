import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();
const deriveTaskStatusMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
  deriveTaskStatus: (...args: unknown[]) => deriveTaskStatusMock(...args),
}));

const { registerOpencodeGetTaskStatus } = await import(
  "../../../src/modules/tools/get_task_status.js"
);

describe("opencode_get_task_status", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    deriveTaskStatusMock.mockReset();
    removeTask("task-1");
  });

  it("returns not_found when the task cannot be resolved", async () => {
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_id: "missing", status: "not_found" }) },
      ],
    });
  });

  it("returns a provisional cached result when its backend is unavailable", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "run-1",
      workspace: {
        mode: "shared",
        source_directory: "/source",
        execution_directory: "/source",
        managed: false,
        state: "active",
      },
      runs: [
        {
          run_id: "run-1",
          message_id: "msg-1",
          startedAt: 1,
          result: { task_id: "task-1", run_id: "run-1", status: "running", result: null },
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "running",
      workspace: { source_directory: "/source" },
    });
  });

  it("returns cached historical run status/report when its backend was removed", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "new",
      runs: [
        {
          run_id: "old",
          message_id: "msg-old",
          startedAt: 1,
          executionState: "completed",
          reportReady: true,
          usage: {
            captured_at: "2026-10-07T00:00:00.000Z",
            snapshot_kind: "run_finalization",
            report: null,
            diagnostic: "usage unavailable: old snapshot",
          },
          report: {
            changes: [{ path: "old.txt", change: "created", evidence: "workspace_delta" }],
            verification: { state: "passed", checks: [], execution_state: "completed" },
            diagnostics: [],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: true,
              errors: [],
              attribution: "uncertain_shared_workspace",
            },
          },
          result: { task_id: "task-1", run_id: "old", status: "completed", result: "done" },
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", run_id: "old" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      run_id: "old",
      status: "completed",
      changes: [{ path: "old.txt", change: "created" }],
      verification: { state: "passed" },
      usage: { snapshot_kind: "run_finalization", report: null },
    });
    expect(deriveTaskStatusMock).not.toHaveBeenCalled();
  });

  it("returns unavailable for a historical run without a cached execution state", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "new",
      runs: [
        {
          run_id: "old",
          message_id: "msg-old",
          startedAt: 1,
          reportReady: true,
          report: {
            changes: [],
            verification: { state: "unavailable", checks: [] },
            diagnostics: ["evidence unavailable"],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: false,
              errors: ["missing baseline"],
              attribution: "uncertain_shared_workspace",
            },
          },
        },
      ],
    });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1", run_id: "old" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "unavailable",
      verification: { state: "unavailable" },
    });
    removeTask("task-1");
  });

  it("includes current run fields and handles a tracked task without a current run", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [
        {
          run_id: "current",
          message_id: "msg-current",
          startedAt: 1,
          expectedChanges: [{ path: "added.txt", change: "created" }],
          dispatchState: "uncertain",
          dispatchError: "connection reset after acceptance",
        },
      ],
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({
      run_id: "current",
      status: "running",
      verification: { state: "pending" },
      dispatch: { state: "uncertain", error: "connection reset after acceptance" },
    });
    removeTask("task-1");

    registerTask({ taskId: "task-1", serverId: "srv", sessionId: "s1", runs: [] });
    clientForTaskMock.mockReturnValue(undefined);
    const unavailable = JSON.parse(
      (await fake.getHandler()({ task_id: "task-1" })).content[0].text,
    );
    expect(unavailable).toMatchObject({ status: "backend_unavailable" });
    expect(unavailable.run_id).toBeUndefined();
    removeTask("task-1");
  });

  it("returns a tracked current run cache or backend-unavailable report without polling", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [
        {
          run_id: "current",
          message_id: "msg-current",
          startedAt: 1,
          reportReady: true,
          executionState: "completed",
          result: { task_id: "task-1", run_id: "current", status: "completed", result: "cached" },
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const cached = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(cached).toMatchObject({ status: "completed", result: "cached", run_id: "current" });
    removeTask("task-1");

    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [{ run_id: "current", message_id: "msg-current", startedAt: 1 }],
    });
    const unavailable = JSON.parse(
      (await fake.getHandler()({ task_id: "task-1" })).content[0].text,
    );
    expect(unavailable).toMatchObject({
      task_id: "task-1",
      status: "backend_unavailable",
      run_id: "current",
    });
    expect(deriveTaskStatusMock).not.toHaveBeenCalled();
  });

  it("reports missing historical IDs, cached progress, and current run readiness", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [
        {
          run_id: "old",
          message_id: "msg-old",
          startedAt: 1,
          executionState: "failed",
          result: {
            task_id: "task-1",
            run_id: "old",
            status: "failed",
            result: null,
            progress: { text_snippet: "partial", tool_calls_completed: 1 },
          },
        },
        {
          run_id: "current",
          message_id: "msg-current",
          startedAt: 2,
          expectedChanges: [{ path: "file.txt", change: "created" }],
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();
    const notFound = await handler({ task_id: "task-1", run_id: "absent" });
    expect(JSON.parse(notFound.content[0].text).status).toBe("run_not_found");
    const old = JSON.parse((await handler({ task_id: "task-1", run_id: "old" })).content[0].text);
    expect(old).toMatchObject({ status: "failed", progress: { text_snippet: "partial" } });
    const current = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);
    expect(current).toMatchObject({
      status: "backend_unavailable",
      verification: { state: "pending" },
      run_id: "current",
    });
    removeTask("task-1");
  });

  it("returns the status derived by deriveTaskStatus", async () => {
    const client = {};
    const usage = {
      captured_at: "2026-10-07T00:00:00.000Z",
      snapshot_kind: "live_observation",
      report: null,
      diagnostic: "usage unavailable: incomplete fixture",
    };
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "run-current",
      runs: [{ run_id: "run-current", message_id: "msg-current", startedAt: 1 }],
    });
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "running", usage });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "running",
      run_id: "run-current",
      usage,
      verification: { state: "not_requested" },
    });
    expect(deriveTaskStatusMock).toHaveBeenCalledWith(client, "s1", "task-1", {
      includeProgress: undefined,
      includeUsage: true,
    });
  });

  it("passes includeProgress through to deriveTaskStatus when include_progress is true", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({
      task_id: "task-1",
      status: "running",
      progress: { text_snippet: "hi", tool_calls_completed: 0 },
    });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", include_progress: true });

    expect(deriveTaskStatusMock).toHaveBeenCalledWith(client, "s1", "task-1", {
      includeProgress: true,
      includeUsage: true,
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "task-1",
            status: "running",
            progress: { text_snippet: "hi", tool_calls_completed: 0 },
          }),
        },
      ],
    });
  });

  it("returns completed status", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "completed" });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ task_id: "task-1", status: "completed" }) }],
    });
  });

  it("returns failed status with error name", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({
      task_id: "task-1",
      status: "failed",
      error: "OOPS",
    });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "failed", error: "OOPS" }),
        },
      ],
    });
  });

  it("returns pending status", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "pending" });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ task_id: "task-1", status: "pending" }) }],
    });
  });

  it("returns an error result when deriveTaskStatus throws an Error", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockRejectedValue(new Error("timeout"));
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "error",
      message: "timeout",
      usage: { report: null, diagnostic: "usage unavailable: timeout" },
    });
  });

  it("returns an error result when deriveTaskStatus throws a non-Error value", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockRejectedValue("nope");
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "error",
      message: "nope",
      usage: { report: null, diagnostic: "usage unavailable: nope" },
    });
  });

  it("attaches current-run diagnostics when status polling fails", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [
        {
          run_id: "current",
          message_id: "msg-current",
          startedAt: 1,
          report: {
            changes: [],
            verification: { state: "unavailable", checks: [], execution_state: "running" },
            diagnostics: ["status observer failed"],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: false,
              errors: ["status read failed"],
              attribution: "uncertain_shared_workspace",
            },
          },
        },
      ],
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    deriveTaskStatusMock.mockRejectedValueOnce(new Error("HTTP 503"));
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({
      status: "error",
      message: "HTTP 503",
      run_id: "current",
      diagnostics: ["status observer failed"],
    });
    removeTask("task-1");
  });
});

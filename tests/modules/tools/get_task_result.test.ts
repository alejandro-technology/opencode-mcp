import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecutionUsage } from "../../../src/modules/shared/execution-usage.js";
import {
  CANCELLED_TASK_MESSAGE,
  EMPTY_TURN_MESSAGE,
} from "../../../src/modules/shared/opencode-client.js";
import { getTask, registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();
const assistantEntriesMock = vi.fn();

// Only the transport-facing helpers are stubbed; buildProgress / hasWork /
// sessionParts / EMPTY_TURN_MESSAGE stay real so the evidence payload is
// asserted end to end.
vi.mock("../../../src/modules/shared/opencode-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/shared/opencode-client.js")>()),
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
  assistantEntries: (...args: unknown[]) => assistantEntriesMock(...args),
  currentRunEntries: (...args: unknown[]) => assistantEntriesMock(...args),
}));

const { registerOpencodeGetTaskResult } = await import(
  "../../../src/modules/tools/get_task_result.js"
);

describe("opencode_get_task_result", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    assistantEntriesMock.mockReset();
    removeTask("task-1");
  });

  it("returns not_found when the task cannot be resolved", async () => {
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_id: "missing", status: "not_found" }) },
      ],
    });
  });

  it("returns a cached historical run without contacting a removed backend", async () => {
    const oldUsage = {
      captured_at: "2026-10-07T00:00:00.000Z",
      snapshot_kind: "run_finalization" as const,
      report: buildExecutionUsage(
        [
          {
            info: {
              id: "assistant-old",
              parentID: "msg-old",
              providerID: "provider-a",
              modelID: "model-a",
              cost: 0,
              tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 1, write: 0 } },
            } as never,
            parts: [],
          },
        ],
        "msg-old",
      ),
    };
    const report = {
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
    };
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "run-new",
      runs: [
        {
          run_id: "run-old",
          message_id: "msg-old",
          startedAt: 1,
          report,
          reportReady: true,
          usage: oldUsage,
          executionState: "completed",
          result: {
            task_id: "task-1",
            run_id: "run-old",
            status: "completed",
            result: "old result",
            usage: oldUsage,
          },
        },
        {
          run_id: "run-new",
          message_id: "msg-new",
          startedAt: 2,
          reportReady: false,
          executionState: "running",
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse(
      (await fake.getHandler()({ task_id: "task-1", run_id: "run-old" })).content[0].text,
    );
    expect(payload).toMatchObject({
      task_id: "task-1",
      run_id: "run-old",
      status: "completed",
      result: "old result",
      verification: { state: "passed" },
      changes: [{ path: "old.txt", change: "created" }],
      usage: oldUsage,
    });
    expect(clientForTaskMock).not.toHaveBeenCalled();
    const repeated = JSON.parse(
      (await fake.getHandler()({ task_id: "task-1", run_id: "run-old" })).content[0].text,
    );
    expect(repeated.usage).toEqual(oldUsage);
    removeTask("task-1");
  });

  it("returns a historical run that is not cached yet as unavailable without querying current output", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [
        {
          run_id: "older",
          message_id: "msg-older",
          startedAt: 1,
          report: {
            changes: [],
            verification: { state: "unavailable", checks: [] },
            diagnostics: ["finalization is unavailable"],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: false,
              errors: ["observer error"],
              attribution: "uncertain_shared_workspace",
            },
          },
        },
      ],
    });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse(
      (await fake.getHandler()({ task_id: "task-1", run_id: "older" })).content[0].text,
    );
    expect(payload).toMatchObject({
      status: "unavailable",
      result: null,
      verification: { state: "unavailable" },
    });
    expect(assistantEntriesMock).not.toHaveBeenCalled();
    removeTask("task-1");
  });

  it("rejects unknown run ids and reports backend errors with cached diagnostics", async () => {
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
          dispatchState: "uncertain",
          dispatchError: "connection reset after acceptance",
          report: {
            changes: [],
            verification: { state: "unavailable", checks: [], execution_state: "completed" },
            diagnostics: ["output is incomplete"],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: false,
              errors: ["output unavailable"],
              attribution: "uncertain_shared_workspace",
            },
          },
        },
      ],
    });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();
    const missing = await handler({ task_id: "task-1", run_id: "unknown" });
    expect(JSON.parse(missing.content[0].text).status).toBe("run_not_found");

    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockRejectedValueOnce(new Error("backend read failed"));
    const failed = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);
    expect(failed).toMatchObject({
      status: "error",
      message: "backend read failed",
      diagnostics: ["output is incomplete"],
      verification: { state: "unavailable" },
      dispatch: { state: "uncertain", error: "connection reset after acceptance" },
    });
    removeTask("task-1");
  });

  it("returns a partial cached result when backend polling is gone before report readiness", async () => {
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
          result: { task_id: "task-1", run_id: "current", status: "running", result: "partial" },
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({
      status: "running",
      result: "partial",
      verification: { state: "pending" },
    });
    removeTask("task-1");
  });

  it("returns backend_unavailable for a tracked but uncached current run", async () => {
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
            verification: { state: "unavailable", checks: [], execution_state: "pending" },
            diagnostics: ["baseline error"],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: false,
              errors: ["baseline error"],
              attribution: "uncertain_shared_workspace",
            },
          },
        },
      ],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({
      task_id: "task-1",
      status: "backend_unavailable",
      run_id: "current",
    });
    removeTask("task-1");
  });

  it("does not claim a report when the tracked backend is absent before finalization", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [{ run_id: "current", message_id: "msg-current", startedAt: 1 }],
    });
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({ status: "backend_unavailable", run_id: "current" });
    expect(payload.diagnostics).toBeUndefined();
    expect(payload.evidence).toBeUndefined();
    removeTask("task-1");
  });

  it("caches a completed getter result once the run report is already finalized", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "current",
      runs: [{ run_id: "current", message_id: "msg-current", startedAt: 1, reportReady: true }],
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: {
          id: "assistant",
          parentID: "msg-current",
          role: "assistant",
          time: { completed: 1 },
        },
        parts: [{ type: "text", text: "final" }],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({ status: "completed", result: "final", run_id: "current" });
    expect(getTask("task-1")?.runs?.[0].result).toMatchObject({
      status: "completed",
      result: "final",
    });
    const repeated = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(repeated.usage).toEqual(payload.usage);
    removeTask("task-1");
  });

  it("reports direct-message run usage and cumulative session usage across models", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      currentRunId: "run-2",
      runs: [{ run_id: "run-2", message_id: "msg-2", startedAt: 2 }],
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: {
          id: "old-assistant",
          parentID: "msg-1",
          time: { completed: 1 },
          providerID: "provider-a",
          modelID: "model-a",
          cost: 0.01,
          tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        },
        parts: [{ type: "text", text: "old" }],
      },
      {
        info: {
          id: "turn-1",
          parentID: "msg-2",
          time: { completed: 2 },
          providerID: "provider-a",
          modelID: "model-a",
          cost: 0,
          tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 1, write: 0 } },
        },
        parts: [{ type: "text", text: "part one" }],
      },
      {
        info: {
          id: "turn-2",
          parentID: "msg-2",
          time: { completed: 3 },
          providerID: "provider-b",
          modelID: "model-b",
          cost: 0.000001,
          tokens: { input: 7, output: 2, reasoning: 3, cache: { read: 2, write: 1 } },
        },
        parts: [
          { type: "text", text: "part two" },
          { type: "step-finish", cost: 8, tokens: { input: 99 } } as never,
        ],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({
      run_id: "run-2",
      usage: {
        report: {
          run: { message_count: 2, input: { value: 12 }, reported_cost: { value: 0.000001 } },
          session: { message_count: 3, input: { value: 22 }, reported_cost: { value: 0.010001 } },
        },
      },
    });
    expect(payload.usage.report.run.breakdown).toHaveLength(2);
    removeTask("task-1");
  });

  it("returns pending with a null result when there is no assistant entry", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ task_id: "task-1", status: "pending", result: null });
    expect(payload.usage).toMatchObject({
      snapshot_kind: "live_observation",
      report: { run: null, session: { message_count: 0, input: { value: null, complete: false } } },
    });
  });

  it("returns failed when the assistant entry has an error", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { error: { name: "OOPS" }, time: {} },
        parts: [],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "failed",
      error: "OOPS",
      result: null,
      usage: { report: { session: { message_count: 1 } } },
    });
  });

  it("returns running with a null result when not completed yet", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([{ info: { time: {} }, parts: [] }]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "running",
      result: null,
      usage: { report: { session: { message_count: 1 } } },
    });
  });

  it("returns the joined text plus side-effect evidence for a real turn", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 123 } },
        parts: [
          { type: "text", text: "Hello, " },
          {
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath: "src/a.ts" } },
          },
          { type: "text", text: "world!" },
        ],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "completed",
      result: "Hello, world!",
      progress: {
        text_snippet: "Hello, world!",
        tool_calls_completed: 1,
        mutating_tool_calls: 1,
        files_touched: ["src/a.ts"],
      },
      usage: { report: { session: { message_count: 1 }, run: null } },
    });
  });

  it("returns empty, not completed, when the finished turn produced nothing", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([{ info: { time: { completed: 123 } }, parts: [] }]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "empty",
      result: null,
      message: EMPTY_TURN_MESSAGE,
      progress: {
        text_snippet: "",
        tool_calls_completed: 0,
        mutating_tool_calls: 0,
        files_touched: [],
      },
      usage: { report: { session: { message_count: 1 } } },
    });
  });

  it("treats a whitespace-only finished turn as empty", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 123 } },
        parts: [{ type: "text", text: "  \n " }],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text).status).toBe("empty");
  });

  it("reports completed with zero files_touched when a turn only ran read-only tools", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 123 } },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "a.ts" } },
          },
        ],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const payload = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);

    // The incident's round 2 shape: the turn ran, but changed nothing.
    expect(payload.status).toBe("completed");
    expect(payload.result).toBe("");
    expect(payload.progress.mutating_tool_calls).toBe(0);
    expect(payload.progress.files_touched).toEqual([]);
  });

  it("collects evidence from earlier turns, not just the final one", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    // The real shape: the agent edits in earlier turns, then closes with "DONE".
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 1 } },
        parts: [
          {
            type: "tool",
            tool: "edit",
            state: { status: "completed", input: { filePath: "e2e/alpha.ts" } },
          },
          {
            type: "tool",
            tool: "edit",
            state: { status: "completed", input: { filePath: "e2e/beta.ts" } },
          },
        ],
      },
      { info: { time: { completed: 2 } }, parts: [{ type: "text", text: "DONE" }] },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const payload = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);

    expect(payload.status).toBe("completed");
    expect(payload.result).toBe("DONE");
    expect(payload.progress.text_snippet).toBe("DONE");
    expect(payload.progress.mutating_tool_calls).toBe(2);
    expect(payload.progress.files_touched).toEqual(["e2e/alpha.ts", "e2e/beta.ts"]);
  });

  it("returns cancelled with the partial output for an aborted task", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 1 } },
        parts: [
          {
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath: "a.ts" } },
          },
        ],
      },
      { info: { time: { completed: 2 } }, parts: [{ type: "text", text: "got halfway" }] },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);

    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);

    expect(payload.status).toBe("cancelled");
    expect(payload.result).toBe("got halfway");
    expect(payload.message).toBe(CANCELLED_TASK_MESSAGE);
    expect(payload.progress.files_touched).toEqual(["a.ts"]);
    removeTask("task-1");
  });

  it("returns a null result for a task cancelled before it produced anything", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);

    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);

    expect(payload.status).toBe("cancelled");
    expect(payload.result).toBeNull();
    removeTask("task-1");
  });

  it("returns an error result when the client throws an Error", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockRejectedValue(new Error("network fail"));
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "error",
      message: "network fail",
      usage: { report: null, diagnostic: "usage unavailable: network fail" },
    });
  });

  it("returns an error result when the client throws a non-Error value", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockRejectedValue("weird");
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      task_id: "task-1",
      status: "error",
      message: "weird",
      usage: { report: null, diagnostic: "usage unavailable: weird" },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();
const deriveTaskStatusMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
  deriveTaskStatus: (...args: unknown[]) => deriveTaskStatusMock(...args),
}));

const { registerOpencodeWaitForTask } = await import("../../../src/modules/tools/wait_for_task.js");

describe("opencode_wait_for_task", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    deriveTaskStatusMock.mockReset();
    delete process.env.MCP_TOOL_TIMEOUT;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns not_found when any task cannot be resolved (fail-fast)", async () => {
    clientForTaskMock.mockImplementation((id: string) => {
      if (id === "missing") return undefined;
      return { client: {}, sessionId: "s1" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_ids: ["task-1", "missing"] });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_ids: ["missing"], status: "not_found" }) },
      ],
    });
    expect(deriveTaskStatusMock).not.toHaveBeenCalled();
  });

  it("returns immediately when all tasks are already completed (all mode)", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock
      .mockResolvedValueOnce({ task_id: "task-1", status: "completed" })
      .mockResolvedValueOnce({ task_id: "task-2", status: "completed" });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_ids: ["task-1", "task-2"], mode: "all" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "all",
            tasks: [
              { task_id: "task-1", status: "completed" },
              { task_id: "task-2", status: "completed" },
            ],
            timed_out: false,
          }),
        },
      ],
    });
    expect(deriveTaskStatusMock).toHaveBeenCalledTimes(2);
  });

  it("polls multiple tasks until all complete (all mode after N polls)", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    let callCount = 0;
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId) => {
      callCount++;
      if (callCount <= 2) {
        return { task_id: taskId, status: "running" };
      }
      if (callCount === 3) {
        return { task_id: taskId, status: taskId === "task-1" ? "completed" : "running" };
      }
      return { task_id: taskId, status: "completed" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1", "task-2"],
      mode: "all",
      poll_interval_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "all",
            tasks: [
              { task_id: "task-1", status: "completed" },
              { task_id: "task-2", status: "completed" },
            ],
            timed_out: false,
          }),
        },
      ],
    });
  });

  it("returns early as soon as one task completes (any mode)", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock
      .mockResolvedValueOnce({ task_id: "task-1", status: "running" })
      .mockResolvedValueOnce({ task_id: "task-2", status: "running" })
      .mockResolvedValueOnce({ task_id: "task-1", status: "completed" })
      .mockResolvedValueOnce({ task_id: "task-2", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1", "task-2"],
      mode: "any",
      poll_interval_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "any",
            tasks: [
              { task_id: "task-1", status: "completed" },
              { task_id: "task-2", status: "running" },
            ],
            timed_out: false,
          }),
        },
      ],
    });
  });

  it("times out in all mode and returns current statuses with timed_out flag", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1"],
      mode: "all",
      timeout_ms: 2000,
      poll_interval_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "all",
            tasks: [{ task_id: "task-1", status: "running" }],
            timed_out: true,
          }),
        },
      ],
    });
  });

  it("times out in any mode and returns current statuses with timed_out flag", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1"],
      mode: "any",
      timeout_ms: 2000,
      poll_interval_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "any",
            tasks: [{ task_id: "task-1", status: "running" }],
            timed_out: true,
          }),
        },
      ],
    });
  });

  it("handles per-task SDK error as a finished task (marked with error status)", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId) => {
      if (taskId === "task-2") {
        throw new Error("SDK error on task-2");
      }
      return { task_id: taskId, status: "completed" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({
      task_ids: ["task-1", "task-2"],
      mode: "all",
    });

    const parsedResult = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsedResult).toEqual({
      mode: "all",
      tasks: [
        { task_id: "task-1", status: "completed" },
        {
          task_id: "task-2",
          status: "error",
          error: "SDK error on task-2",
        },
      ],
      timed_out: false,
    });
  });

  it("clamps timeout_ms to the configured max and poll_interval_ms to the min", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId) => {
      return { task_id: taskId, status: "completed" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    // Should complete immediately on first status check (completed)
    const result = await handler({
      task_ids: ["task-1"],
      timeout_ms: 9_999_999, // Clamped to the configured max (default 300000)
      poll_interval_ms: 1, // Clamped to 500
    });

    const parsedResult = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsedResult.mode).toBe("all");
    expect(parsedResult.tasks[0].task_id).toBe("task-1");
    expect(parsedResult.tasks[0].status).toBe("completed");
    expect(parsedResult.timed_out).toBe(false);
  });

  it("uses default timeout and poll interval when not provided", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    let callCount = 0;
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId) => {
      callCount++;
      return { task_id: taskId, status: "completed" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_ids: ["task-1"] });

    const parsedResult = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsedResult).toEqual({
      mode: "all",
      tasks: [{ task_id: "task-1", status: "completed" }],
      timed_out: false,
    });
    expect(callCount).toBe(1);
  });

  it("defaults to 'all' mode when mode is not provided", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId) => {
      return { task_id: taskId, status: "completed" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_ids: ["task-1"] }); // No mode specified

    const parsedResult = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsedResult.mode).toBe("all");
    expect(parsedResult.timed_out).toBe(false);
  });

  it("handles deriveTaskStatus rejection as per-task error (not outer error)", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async () => {
      throw new Error("network error");
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_ids: ["task-1"] });

    // Per-task errors are included in the result, not returned as jsonError
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.mode).toBe("all");
    expect(parsed.tasks[0].task_id).toBe("task-1");
    expect(parsed.tasks[0].status).toBe("error");
    expect(parsed.tasks[0].error).toBe("network error");
    expect(parsed.timed_out).toBe(false);
  });

  it("handles deriveTaskStatus rejection with non-Error value as per-task error", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async () => {
      throw "unexpected";
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_ids: ["task-1"] });

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.mode).toBe("all");
    expect(parsed.tasks[0].task_id).toBe("task-1");
    expect(parsed.tasks[0].status).toBe("error");
    expect(parsed.tasks[0].error).toBe("unexpected");
    expect(parsed.timed_out).toBe(false);
  });

  it("handles mixed task statuses across multiple polls (any mode)", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock
      .mockResolvedValueOnce({ task_id: "task-1", status: "running" })
      .mockResolvedValueOnce({ task_id: "task-2", status: "failed", error: "FAILED" })
      .mockResolvedValueOnce({ task_id: "task-3", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1", "task-2", "task-3"],
      mode: "any",
      poll_interval_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    const parsedResult = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsedResult.mode).toBe("any");
    expect(parsedResult.timed_out).toBe(false);
    expect(
      parsedResult.tasks.some(
        (t: { task_id: string; status: string }) => t.task_id === "task-2" && t.status === "failed",
      ),
    ).toBe(true);
  });

  it("skips re-polling a task that already finished on a prior iteration", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId) => {
      if (taskId === "task-1") {
        return { task_id: "task-1", status: "completed" };
      }
      // task-2 stays "running" for two polls, then completes on the third.
      const timesCalled = deriveTaskStatusMock.mock.calls.filter(
        (call) => call[2] === "task-2",
      ).length;
      return { task_id: "task-2", status: timesCalled >= 3 ? "completed" : "running" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1", "task-2"],
      mode: "all",
      poll_interval_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.timed_out).toBe(false);
    expect(parsed.tasks).toEqual([
      { task_id: "task-1", status: "completed" },
      { task_id: "task-2", status: "completed" },
    ]);
    // task-1 must only be polled once — subsequent iterations skip it (already finished).
    expect(deriveTaskStatusMock.mock.calls.filter((call) => call[2] === "task-1").length).toBe(1);
  });

  it("respects a custom MCP_TOOL_TIMEOUT clamp from the environment", async () => {
    process.env.MCP_TOOL_TIMEOUT = "1000";
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    // timeout_ms requested is way above the configured max (1000ms), so it clamps down.
    const promise = handler({
      task_ids: ["task-1"],
      timeout_ms: 999_999,
      poll_interval_ms: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.timed_out).toBe(true);
  });

  it("enriches unfinished tasks with progress on timeout when include_progress is true", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId, options) => {
      if (options?.includeProgress) {
        return {
          task_id: taskId,
          status: "running",
          progress: { text_snippet: "partial output", tool_calls_completed: 2 },
        };
      }
      return { task_id: taskId, status: "running" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1"],
      mode: "all",
      timeout_ms: 2000,
      poll_interval_ms: 1000,
      include_progress: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.timed_out).toBe(true);
    expect(parsed.tasks).toEqual([
      {
        task_id: "task-1",
        status: "running",
        progress: { text_snippet: "partial output", tool_calls_completed: 2 },
      },
    ]);
  });

  it("does not request progress during polling, only once at the end", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    const includeProgressCalls: Array<boolean | undefined> = [];
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId, options) => {
      includeProgressCalls.push(options?.includeProgress);
      return { task_id: taskId, status: "running" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1"],
      mode: "all",
      timeout_ms: 2000,
      poll_interval_ms: 1000,
      include_progress: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Polling iterations (no progress) + one final enrichment call (with progress).
    expect(includeProgressCalls.slice(0, -1).every((v) => v === undefined)).toBe(true);
    expect(includeProgressCalls.at(-1)).toBe(true);
  });

  it("falls back to the un-enriched entry when progress re-derivation fails", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId, options) => {
      if (options?.includeProgress) {
        throw new Error("boom");
      }
      return { task_id: taskId, status: "running" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1"],
      mode: "all",
      timeout_ms: 1000,
      poll_interval_ms: 1000,
      include_progress: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.timed_out).toBe(true);
    expect(parsed.tasks).toEqual([{ task_id: "task-1", status: "running" }]);
  });

  it("enriches unfinished tasks in mode 'any' when include_progress is true", async () => {
    vi.useFakeTimers();
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockImplementation(async (_client, _sessionId, taskId, options) => {
      if (taskId === "task-1") return { task_id: "task-1", status: "completed" };
      if (options?.includeProgress) {
        return {
          task_id: "task-2",
          status: "running",
          progress: { text_snippet: "still going", tool_calls_completed: 1 },
        };
      }
      return { task_id: "task-2", status: "running" };
    });
    const fake = createFakeMcpServer();
    registerOpencodeWaitForTask(fake.server);
    const handler = fake.getHandler();

    const promise = handler({
      task_ids: ["task-1", "task-2"],
      mode: "any",
      poll_interval_ms: 1000,
      include_progress: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.timed_out).toBe(false);
    expect(parsed.tasks).toEqual([
      { task_id: "task-1", status: "completed" },
      {
        task_id: "task-2",
        status: "running",
        progress: { text_snippet: "still going", tool_calls_completed: 1 },
      },
    ]);
  });
});

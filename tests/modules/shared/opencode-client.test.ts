import { beforeEach, describe, expect, it, vi } from "vitest";

const createOpencodeClientMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));

import {
  buildProgress,
  clientForServer,
  clientForTask,
  deriveTaskStatus,
  lastAssistantEntry,
  PENDING_STALL_MS,
} from "../../../src/modules/shared/opencode-client.js";
import { killAllServers, registerServer } from "../../../src/modules/shared/server-registry.js";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";

describe("clientForServer", () => {
  beforeEach(() => {
    killAllServers();
    createOpencodeClientMock.mockReset();
  });

  it("returns undefined when the server id is unknown", () => {
    expect(clientForServer("missing")).toBeUndefined();
    expect(createOpencodeClientMock).not.toHaveBeenCalled();
  });

  it("builds a client from the registered server's baseUrl", () => {
    const fakeClient = { fake: true };
    createOpencodeClientMock.mockReturnValue(fakeClient);
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });

    const client = clientForServer("srv-1");

    expect(client).toBe(fakeClient);
    expect(createOpencodeClientMock).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:4096" });
  });
});

describe("clientForTask", () => {
  beforeEach(() => {
    killAllServers();
    createOpencodeClientMock.mockReset();
    removeTask("task-1");
  });

  it("returns undefined when the task id is unknown", () => {
    expect(clientForTask("missing")).toBeUndefined();
  });

  it("returns undefined when the task's server is unknown", () => {
    registerTask({ taskId: "task-1", serverId: "srv-missing", sessionId: "session-1" });
    expect(clientForTask("task-1")).toBeUndefined();
  });

  it("resolves the client and session id for a known task", () => {
    const fakeClient = { fake: true };
    createOpencodeClientMock.mockReturnValue(fakeClient);
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });

    const resolved = clientForTask("task-1");

    expect(resolved).toEqual({ client: fakeClient, sessionId: "session-1" });
  });
});

describe("lastAssistantEntry", () => {
  it("returns undefined when there are no messages", async () => {
    const client = { session: { messages: vi.fn().mockResolvedValue({ data: [] }) } };
    const entry = await lastAssistantEntry(client as never, "session-1");
    expect(entry).toBeUndefined();
  });

  it("returns undefined when data is missing", async () => {
    const client = { session: { messages: vi.fn().mockResolvedValue({}) } };
    const entry = await lastAssistantEntry(client as never, "session-1");
    expect(entry).toBeUndefined();
  });

  it("returns undefined when no message has the assistant role", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "user" }, parts: [] }],
        }),
      },
    };
    const entry = await lastAssistantEntry(client as never, "session-1");
    expect(entry).toBeUndefined();
  });

  it("returns the most recent assistant message", async () => {
    const olderAssistant = { info: { role: "assistant", id: "old" }, parts: [] };
    const newestAssistant = { info: { role: "assistant", id: "new" }, parts: [{ type: "text" }] };
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [olderAssistant, { info: { role: "user" }, parts: [] }, newestAssistant],
        }),
      },
    };

    const entry = await lastAssistantEntry(client as never, "session-1");

    expect(entry).toEqual({ info: newestAssistant.info, parts: newestAssistant.parts });
  });
});

describe("deriveTaskStatus", () => {
  it("returns running when the session is busy", async () => {
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }) },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
  });

  it("returns running when the session is retrying", async () => {
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "retry" } } }) },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
  });

  it("returns pending when not busy and there is no assistant entry", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "pending" });
  });

  it("returns pending for a recently started task with no assistant entry", async () => {
    registerTask({ taskId: "task-fresh", serverId: "srv", sessionId: "s1", createdAt: Date.now() });
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-fresh");
    expect(result).toEqual({ task_id: "task-fresh", status: "pending" });
    removeTask("task-fresh");
  });

  it("returns failed when an idle task has no assistant entry past the stall window", async () => {
    registerTask({
      taskId: "task-stalled",
      serverId: "srv",
      sessionId: "s1",
      createdAt: Date.now() - PENDING_STALL_MS - 1,
    });
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-stalled");
    expect(result).toEqual({
      task_id: "task-stalled",
      status: "failed",
      error:
        "task produced no output after starting; the prompt was likely rejected (e.g. invalid model or agent)",
    });
    removeTask("task-stalled");
  });

  it("returns failed when the assistant entry has an error", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "assistant", error: { name: "OOPS" }, time: {} }, parts: [] }],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "failed", error: "OOPS" });
  });

  it("returns completed when the assistant entry has completed time", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "assistant", time: { completed: 123 } }, parts: [] }],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "completed" });
  });

  it("returns running when the assistant entry has no completed time and no error", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "assistant", time: {} }, parts: [] }],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
  });

  it("does not call messages when includeProgress is false/absent on the busy path", async () => {
    const messages = vi.fn();
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }), messages },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
    expect(messages).not.toHaveBeenCalled();
  });

  it("includes progress on the busy path when includeProgress is true", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({
      task_id: "task-1",
      status: "running",
      progress: { text_snippet: "hello", tool_calls_completed: 0 },
    });
  });

  it("omits progress on the busy path when there is no assistant entry yet", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({ task_id: "task-1", status: "running", progress: undefined });
  });

  it("includes progress on the not-completed fallback path when includeProgress is true", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: {} },
              parts: [{ type: "text", text: "still working" }],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({
      task_id: "task-1",
      status: "running",
      progress: { text_snippet: "still working", tool_calls_completed: 0 },
    });
  });
});

describe("buildProgress", () => {
  it("concatenates text parts and truncates the snippet to the last ~500 chars", () => {
    const longText = "a".repeat(300) + "b".repeat(300);
    const parts = [
      { type: "text", text: "a".repeat(300) },
      { type: "text", text: "b".repeat(300) },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.text_snippet).toBe(longText.slice(-500));
    expect(progress.text_snippet.length).toBe(500);
    expect(progress.tool_calls_completed).toBe(0);
  });

  it("counts completed tool parts and tracks the last running/pending tool", () => {
    const parts = [
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "grep", state: { status: "completed" } },
      { type: "tool", tool: "edit", state: { status: "pending" } },
      { type: "tool", tool: "write", state: { status: "running" } },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.tool_calls_completed).toBe(2);
    expect(progress.current_tool).toBe("write");
    expect(progress.current_tool_status).toBe("running");
  });

  it("ignores error tool parts and leaves current_tool undefined when nothing is running/pending", () => {
    const parts = [{ type: "tool", tool: "bash", state: { status: "error" } }];
    const progress = buildProgress(parts as never);
    expect(progress.tool_calls_completed).toBe(0);
    expect(progress.current_tool).toBeUndefined();
    expect(progress.current_tool_status).toBeUndefined();
  });

  it("ignores part types that are neither text nor tool", () => {
    const parts = [{ type: "step-start" }];
    const progress = buildProgress(parts as never);
    expect(progress).toEqual({ text_snippet: "", tool_calls_completed: 0 });
  });

  it("returns an empty snippet when there are no parts", () => {
    const progress = buildProgress([]);
    expect(progress).toEqual({ text_snippet: "", tool_calls_completed: 0 });
  });
});

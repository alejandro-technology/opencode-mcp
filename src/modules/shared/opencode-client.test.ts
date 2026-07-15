import { beforeEach, describe, expect, it, vi } from "vitest";

const createOpencodeClientMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));

import {
  clientForServer,
  clientForTask,
  deriveTaskStatus,
  lastAssistantEntry,
} from "./opencode-client.js";
import { killAllServers, registerServer } from "./server-registry.js";
import { registerTask, removeTask } from "./task-registry.js";

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
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
}));

const { registerOpencodeCancelTask } = await import("../../../src/modules/tools/cancel_task.js");

describe("opencode_cancel_task", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
  });

  it("returns task_not_found when the task cannot be resolved", async () => {
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_id: "missing", status: "task_not_found" }) },
      ],
    });
  });

  it("aborts the session and returns cancelled status", async () => {
    const abort = vi.fn().mockResolvedValue({});
    clientForTaskMock.mockReturnValue({
      client: { session: { abort } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(abort).toHaveBeenCalledWith({ path: { id: "session-1" } });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "task-1",
            session_id: "session-1",
            status: "cancelled",
          }),
        },
      ],
    });
  });

  it("returns an error result when the SDK throws an Error", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { abort: vi.fn().mockRejectedValue(new Error("db down")) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "db down" }),
        },
      ],
    });
  });

  it("returns an error result when the SDK throws a non-Error value", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { abort: vi.fn().mockRejectedValue("weird") } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "weird" }),
        },
      ],
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();
const deriveTaskStatusMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
  deriveTaskStatus: (...args: unknown[]) => deriveTaskStatusMock(...args),
}));

const { registerOpencodeGetTaskStatus } = await import("../../../src/modules/tools/get_task_status.js");

describe("opencode_get_task_status", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    deriveTaskStatusMock.mockReset();
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

  it("returns the status derived by deriveTaskStatus", async () => {
    const client = {};
    clientForTaskMock.mockReturnValue({ client, sessionId: "s1" });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "task-1", status: "running" });
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskStatus(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ task_id: "task-1", status: "running" }) }],
    });
    expect(deriveTaskStatusMock).toHaveBeenCalledWith(client, "s1", "task-1");
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

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "timeout" }),
        },
      ],
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

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "nope" }),
        },
      ],
    });
  });
});

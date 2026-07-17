import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
}));

const { registerOpencodeContinueTask } = await import(
  "../../../src/modules/tools/continue_task.js"
);

describe("opencode_continue_task", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
  });

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
        parts: [{ type: "text", text: "keep going" }],
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      },
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "task-1",
            session_id: "session-1",
            status: "pending",
          }),
        },
      ],
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
      body: { parts: [{ type: "text", text: "keep going" }] },
    });
  });

  it("returns an error result when the SDK throws an Error", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { promptAsync: vi.fn().mockRejectedValue(new Error("db down")) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", prompt: "hi" });

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
      client: { session: { promptAsync: vi.fn().mockRejectedValue("weird") } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeContinueTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1", prompt: "hi" });

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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../test-utils/fake-mcp-server.js";

vi.mock("node:crypto", () => ({
  randomUUID: () => "generated-task-id",
}));

const { registerOpencodeStartTask } = await import("./start_task.js");
const { registerServer, killAllServers } = await import("../shared/server-registry.js");

describe("opencode_start_task", () => {
  beforeEach(() => {
    killAllServers();
  });

  it("returns server_not_found for an unknown server", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "missing", prompt: "do stuff" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "missing", status: "server_not_found" }),
        },
      ],
    });
  });

  it("returns invalid_model when model is malformed", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi", model: "no-slash" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          }),
        },
      ],
    });
  });

  it("returns invalid_model when the slash is at position 0 or end", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi", model: "/trailing" });
    expect(result).toMatchObject({ isError: true });

    const result2 = await handler({ server_id: "srv-1", prompt: "hi", model: "leading/" });
    expect(result2).toMatchObject({ isError: true });
  });

  it("returns an error when session creation fails to yield an id", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({}),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("./start_task.js");
    const registry = await import("../shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            status: "error",
            message: "failed to create session",
          }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("creates a session, starts the prompt, and registers a task", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync: vi.fn().mockResolvedValue({}),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("./start_task.js");
    const registry = await import("../shared/server-registry.js");
    const tasks = await import("../shared/task-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({
      server_id: "srv-1",
      prompt: "do the thing",
      agent: "build",
      model: "anthropic/claude-sonnet-4",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "generated-task-id",
            server_id: "srv-1",
            session_id: "session-1",
            status: "pending",
          }),
        },
      ],
    });
    expect(tasks.getTask("generated-task-id")).toEqual({
      taskId: "generated-task-id",
      serverId: "srv-1",
      sessionId: "session-1",
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("creates a session without optional agent or model fields", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    const promptAsync = vi.fn().mockResolvedValue({});
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync,
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("./start_task.js");
    const registry = await import("../shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    await handler({ server_id: "srv-1", prompt: "do the thing" });

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "do the thing" }] },
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("returns an error result when the SDK throws an Error", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockRejectedValue(new Error("db down")),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("./start_task.js");
    const registry = await import("../shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "db down" }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("returns an error result when the SDK throws a non-Error value", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockRejectedValue("weird"),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("./start_task.js");
    const registry = await import("../shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "weird" }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });
});

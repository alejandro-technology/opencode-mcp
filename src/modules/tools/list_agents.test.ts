import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../test-utils/fake-mcp-server.js";

const createOpencodeClientMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));

const { registerOpencodeListAgents } = await import("./list_agents.js");
const { registerServer, killAllServers } = await import("../shared/server-registry.js");

describe("opencode_list_agents", () => {
  beforeEach(() => {
    killAllServers();
    createOpencodeClientMock.mockReset();
  });

  it("returns not_found for an unknown server", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ server_id: "missing", status: "not_found" }) },
      ],
    });
  });

  it("returns the list of agents on success", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClientMock.mockReturnValue({
      app: { agents: vi.fn().mockResolvedValue({ data: [{ name: "build" }] }) },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ server_id: "srv-1", agents: [{ name: "build" }] }) },
      ],
    });
  });

  it("defaults to an empty array when data is missing", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClientMock.mockReturnValue({
      app: { agents: vi.fn().mockResolvedValue({}) },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ server_id: "srv-1", agents: [] }) }],
    });
  });

  it("returns an error result when the SDK reports an object error with a message", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClientMock.mockReturnValue({
      app: { agents: vi.fn().mockResolvedValue({ error: { message: "bad request" } }) },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "bad request" }),
        },
      ],
    });
  });

  it("returns an error result when the SDK reports a non-object error", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClientMock.mockReturnValue({
      app: { agents: vi.fn().mockResolvedValue({ error: "plain string error" }) },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            status: "error",
            message: "plain string error",
          }),
        },
      ],
    });
  });

  it("returns an error result when the request throws an Error", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClientMock.mockReturnValue({
      app: { agents: vi.fn().mockRejectedValue(new Error("network down")) },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "network down" }),
        },
      ],
    });
  });

  it("returns an error result when the request throws a non-Error value", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    createOpencodeClientMock.mockReturnValue({
      app: { agents: vi.fn().mockRejectedValue("weird failure") },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "weird failure" }),
        },
      ],
    });
  });
});

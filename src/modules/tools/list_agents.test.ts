import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../test-utils/fake-mcp-server.js";

const createOpencodeClientMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));

const { registerOpencodeListAgents } = await import("./list_agents.js");
const { registerServer, killAllServers } = await import("../shared/server-registry.js");

function mockClient({
  agents = { data: [] },
  providers = { data: { providers: [], default: {} } },
}: {
  agents?: unknown;
  providers?: unknown;
} = {}) {
  createOpencodeClientMock.mockReturnValue({
    app: {
      agents:
        agents instanceof Error
          ? vi.fn().mockRejectedValue(agents)
          : vi.fn().mockResolvedValue(agents),
    },
    config: { providers: vi.fn().mockResolvedValue(providers) },
  });
}

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

  it("splits agents into native/custom and summarizes models and providers", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    mockClient({
      agents: {
        data: [
          {
            name: "plan",
            mode: "primary",
            native: true,
            description: "Planning agent",
            model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
            tools: {},
            permission: {},
            options: {},
          },
          {
            name: "legacy-build",
            mode: "primary",
            builtIn: true,
            tools: {},
            permission: {},
            options: {},
          },
          {
            name: "reviewer",
            mode: "subagent",
            native: false,
            tools: {},
            permission: {},
            options: {},
          },
          {
            name: "no-flags",
            mode: "subagent",
            tools: {},
            permission: {},
            options: {},
          },
        ],
      },
      providers: {
        data: {
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: { "claude-sonnet-5": {}, "claude-opus-4-8": {} },
            },
          ],
          default: { anthropic: "claude-sonnet-5" },
        },
      },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            agents: {
              native: [
                {
                  name: "plan",
                  mode: "primary",
                  description: "Planning agent",
                  model: "anthropic/claude-sonnet-5",
                },
                { name: "legacy-build", mode: "primary" },
              ],
              custom: [
                { name: "reviewer", mode: "subagent" },
                { name: "no-flags", mode: "subagent" },
              ],
            },
            models: {
              defaults: { anthropic: "claude-sonnet-5" },
              providers: [
                {
                  provider: "anthropic",
                  name: "Anthropic",
                  models: ["claude-sonnet-5", "claude-opus-4-8"],
                },
              ],
            },
          }),
        },
      ],
    });
  });

  it("defaults to empty collections when data is missing", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    mockClient({ agents: {}, providers: {} });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            agents: { native: [], custom: [] },
            models: { defaults: {}, providers: [] },
          }),
        },
      ],
    });
  });

  it("returns an error result when the agents call reports an object error with a message", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    mockClient({ agents: { error: { message: "bad request" } } });
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

  it("returns an error result when the providers call reports a non-object error", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    mockClient({ providers: { error: "plain string error" } });
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
    mockClient({ agents: new Error("network down") });
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
      config: { providers: vi.fn().mockResolvedValue({ data: { providers: [], default: {} } }) },
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

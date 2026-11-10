import { writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../../../src/modules/shared/db/index.js";
import { upsertUsageLedger } from "../../../src/modules/shared/db/usage.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const createOpencodeClientMock = vi.fn();
const getUsageLimitsMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));
vi.mock("../../../src/modules/shared/usage-limits.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/modules/shared/usage-limits.js")>();
  return { ...actual, getUsageLimits: getUsageLimitsMock };
});

const { registerOpencodeListAgents } = await import("../../../src/modules/tools/list_agents.js");
const { registerServer, killAllServers } = await import(
  "../../../src/modules/shared/server-registry.js"
);

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

const ORIGINAL_DB_ENV = process.env.OPENCODE_MCP_HISTORY_DB;
const NO_LEDGER_REASON = "no usage ledger rows in the last 7 days";

function restoreDbEnv(): void {
  if (ORIGINAL_DB_ENV === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
  else process.env.OPENCODE_MCP_HISTORY_DB = ORIGINAL_DB_ENV;
}

describe("opencode_list_agents", () => {
  beforeEach(() => {
    killAllServers();
    resetDbForTests();
    restoreDbEnv();
    createOpencodeClientMock.mockReset();
    getUsageLimitsMock.mockReset();
    getUsageLimitsMock.mockResolvedValue(null);
  });

  afterEach(() => {
    resetDbForTests();
    restoreDbEnv();
  });

  it("returns not_found for an unknown server", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "missing",
            status: "not_found",
            message:
              "server_id is not registered in this MCP process; call opencode_start_server and use the server_id it returned",
          }),
        },
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
            directory: process.cwd(),
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
              quota_snapshot: null,
              local_usage: null,
              local_usage_reason: NO_LEDGER_REASON,
              providers: [
                {
                  provider: "anthropic",
                  name: "Anthropic",
                  models: [
                    { id: "claude-sonnet-5", quota: null },
                    { id: "claude-opus-4-8", quota: null },
                  ],
                },
              ],
            },
          }),
        },
      ],
    });
  });

  it("joins the cached quota table onto live model ids", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    getUsageLimitsMock.mockResolvedValue({
      source: "https://opencode.ai/docs/es/go/#l\u00edmites-de-uso",
      fetchedAt: "2026-08-21T10:00:00.000Z",
      spendBudget: { fiveHours: "$12", weekly: "$30", monthly: "$60" },
      models: [
        { model: "MiMo-V2.5", perFiveHours: 30_100, perWeek: 75_200, perMonth: 150_400 },
        { model: "GLM-5.2", perFiveHours: 880, perWeek: 2_150, perMonth: 4_300 },
        { model: "Grok 4.5", perFiveHours: 120, perWeek: 300, perMonth: 600 },
        { model: "Ox Alpha Free", perFiveHours: null, perWeek: null, perMonth: null },
      ],
    });
    mockClient({
      providers: {
        data: {
          providers: [
            {
              id: "opencode-go",
              name: "OpenCode Go",
              models: { "mimo-v2.5": {}, "glm-5.2": {}, "grok-4.5": {}, "ox-alpha-free": {} },
            },
            { id: "opencode", name: "OpenCode", models: { "big-pickle": {} } },
          ],
          default: {},
        },
      },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.models.quota_snapshot).toEqual({
      source: "https://opencode.ai/docs/es/go/#l\u00edmites-de-uso",
      checked: "2026-08-21",
    });
    expect(payload.models.providers[0].models).toEqual([
      { id: "mimo-v2.5", quota: { per_5h: 30_100, tier: "high-volume" } },
      { id: "ox-alpha-free", quota: { per_5h: 3_000, tier: "free" } },
      { id: "glm-5.2", quota: { per_5h: 880, tier: "balanced" } },
      { id: "grok-4.5", quota: { per_5h: 120, tier: "scarce" } },
    ]);
    // Not an OpenCode Go model: no row in the docs table.
    expect(payload.models.providers[1].models).toEqual([{ id: "big-pickle", quota: null }]);
  });

  it("sorts models by tier and per_5h descending, and joins dot-to-dash ids", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    getUsageLimitsMock.mockResolvedValue({
      source: "https://opencode.ai/docs/es/go/#l\u00edmites-de-uso",
      fetchedAt: "2026-08-21T10:00:00.000Z",
      spendBudget: { fiveHours: "$12", weekly: "$30", monthly: "$60" },
      models: [
        { model: "Claude Haiku 5.5", perFiveHours: 5_000, perWeek: 12_500, perMonth: 25_000 },
        { model: "MiMo-V2.5", perFiveHours: 30_100, perWeek: 75_200, perMonth: 150_400 },
        { model: "GLM-5.2", perFiveHours: 880, perWeek: 2_150, perMonth: 4_300 },
        { model: "Grok 4.5", perFiveHours: 120, perWeek: 300, perMonth: 600 },
        { model: "Ox Alpha Free", perFiveHours: null, perWeek: null, perMonth: null },
      ],
    });
    mockClient({
      providers: {
        data: {
          providers: [
            {
              id: "opencode-go",
              name: "OpenCode Go",
              models: {
                "grok-4.5": {},
                "mimo-v2.5": {},
                "ox-alpha-free": {},
                "claude-haiku-5-5": {},
                "glm-5.2": {},
              },
            },
            {
              id: "opencode",
              name: "OpenCode",
              models: { "big-pickle": {}, "tiny-pickle": {} },
            },
          ],
          default: {},
        },
      },
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.models.providers[0].models).toEqual([
      { id: "mimo-v2.5", quota: { per_5h: 30_100, tier: "high-volume" } },
      { id: "claude-haiku-5-5", quota: { per_5h: 5_000, tier: "high-volume" } },
      { id: "ox-alpha-free", quota: { per_5h: 3_000, tier: "free" } },
      { id: "glm-5.2", quota: { per_5h: 880, tier: "balanced" } },
      { id: "grok-4.5", quota: { per_5h: 120, tier: "scarce" } },
    ]);
    // OpenCode provider models have no docs row, so they sort after free.
    expect(payload.models.providers[1].models).toEqual([
      { id: "big-pickle", quota: null },
      { id: "tiny-pickle", quota: null },
    ]);
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
            directory: process.cwd(),
            agents: { native: [], custom: [] },
            models: {
              defaults: {},
              quota_snapshot: null,
              local_usage: null,
              local_usage_reason: NO_LEDGER_REASON,
              providers: [],
            },
          }),
        },
      ],
    });
  });

  it("binds discovery to the explicitly selected canonical directory", async () => {
    const directory = await realpath(process.cwd());
    registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: process.cwd(),
      close: vi.fn(),
    });
    mockClient();
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const result = await fake.getHandler()({ server_id: "srv-1", directory: "." });
    expect(createOpencodeClientMock).toHaveBeenCalledWith(expect.objectContaining({ directory }));
    expect(JSON.parse(result.content[0].text).directory).toBe(directory);
  });

  it("rejects an existing file as a selected project directory", async () => {
    registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const result = await fake.getHandler()({
      server_id: "srv-1",
      directory: "src/modules/tools/list_agents.ts",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "invalid_directory" });
  });

  it("reports a missing selected project directory as invalid", async () => {
    registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const result = await fake.getHandler()({
      server_id: "srv-1",
      directory: "missing-project-directory",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "invalid_directory" });
  });

  it("reports unexpected canonicalization failures without starting a client", async () => {
    const root = await mkdtemp(join(tmpdir(), "list-agent-directory-loop-"));
    const firstLink = join(root, "first");
    const secondLink = join(root, "second");
    await symlink(secondLink, firstLink);
    await symlink(firstLink, secondLink);
    registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);
    const result = await fake.getHandler()({ server_id: "srv-1", directory: firstLink });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "error" });
    expect(createOpencodeClientMock).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it("handles a server disappearing while its project client is being built", async () => {
    vi.doMock("../../../src/modules/shared/opencode-client.js", () => ({
      clientForServer: () => undefined,
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/list_agents.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.registerServer({
      serverId: "vanishing-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeListAgents(fake.server);
    const result = await fake.getHandler()({ server_id: "vanishing-server" });
    expect(JSON.parse(result.content[0].text).status).toBe("not_found");
    vi.doUnmock("../../../src/modules/shared/opencode-client.js");
    vi.resetModules();
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

  it("exposes rolling local usage next to the quota snapshot", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    mockClient();
    const now = Date.now();
    upsertUsageLedger({
      runId: "run-recent",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: now,
      messageCount: 2,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 1,
      cacheRead: 2,
      cacheWrite: 3,
      reportedCost: 0.25,
      complete: true,
      breakdown: null,
    });
    upsertUsageLedger({
      runId: "run-older",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: now - 6 * 3600 * 1000,
      messageCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 1,
      cacheRead: 1,
      cacheWrite: 1,
      reportedCost: 0.5,
      complete: true,
      breakdown: null,
    });
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);

    const result = await fake.getHandler()({ server_id: "srv-1" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.models.local_usage_reason).toBeNull();
    expect(payload.models.local_usage.five_hours.ledger_runs).toBe(1);
    expect(payload.models.local_usage.five_hours.message_count).toBe(2);
    expect(payload.models.local_usage.five_hours.input.value).toBe(10);
    expect(payload.models.local_usage.seven_days.ledger_runs).toBe(2);
    expect(payload.models.local_usage.seven_days.input.value).toBe(11);
  });

  it("keeps serving agents when the usage ledger database is unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "list-agents-db-"));
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    resetDbForTests();
    process.env.OPENCODE_MCP_HISTORY_DB = join(blocker, "history.sqlite");
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    mockClient();
    const fake = createFakeMcpServer();
    registerOpencodeListAgents(fake.server);

    const result = await fake.getHandler()({ server_id: "srv-1" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.server_id).toBe("srv-1");
    expect(payload.models.local_usage).toBeNull();
    expect(payload.models.local_usage_reason).toContain("usage ledger unavailable");
    await rm(root, { recursive: true, force: true });
  });
});

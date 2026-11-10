import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "../../../src/modules/shared/db/index.js";
import { servers as serversTable } from "../../../src/modules/shared/db/schema.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const createOpencodeServerMock = vi.fn();
const createOpencodeClientMock = vi.fn();
const realpathMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: (...args: unknown[]) => createOpencodeServerMock(...args),
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "generated-uuid",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: ((...args: unknown[]) => realpathMock(...args)) as typeof actual.realpath,
  };
});

const getExternalDirectoryPolicyMock = vi.fn();
const buildServerConfigMock = vi.fn();
const startPermissionResponderMock = vi.fn();

vi.mock("../../../src/modules/shared/permissions.js", () => ({
  getExternalDirectoryPolicy: () => getExternalDirectoryPolicyMock(),
  buildServerConfig: (...args: unknown[]) => buildServerConfigMock(...args),
  startPermissionResponder: (...args: unknown[]) => startPermissionResponderMock(...args),
}));

const { registerOpencodeStartServer } = await import("../../../src/modules/tools/start_server.js");
const { getServer, killAllServers } = await import(
  "../../../src/modules/shared/server-registry.js"
);
const actualPermissions = await vi.importActual<
  typeof import("../../../src/modules/shared/permissions.js")
>("../../../src/modules/shared/permissions.js");
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const originalArgv = [...process.argv];

describe("opencode_start_server", () => {
  beforeEach(() => {
    createOpencodeServerMock.mockReset();
    createOpencodeClientMock.mockReset();
    getExternalDirectoryPolicyMock.mockReset();
    buildServerConfigMock.mockReset();
    startPermissionResponderMock.mockReset();
    realpathMock.mockReset();
    killAllServers();

    getExternalDirectoryPolicyMock.mockImplementation(actualPermissions.getExternalDirectoryPolicy);
    realpathMock.mockImplementation(actualFs.realpath);
    buildServerConfigMock.mockReturnValue({ permission: { external_directory: "ask" } });
    startPermissionResponderMock.mockReturnValue({ stop: vi.fn(), done: Promise.resolve() });
    createOpencodeClientMock.mockReturnValue({ fake: "client" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.argv = [...originalArgv];
  });

  it("starts a server with the permission config, registers it, and returns its id", async () => {
    const close = vi.fn();
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(buildServerConfigMock).toHaveBeenCalledWith("read-only", {
      rootDirectory: await realpath(process.cwd()),
    });
    expect(createOpencodeServerMock).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 4096,
      timeout: 10_000,
      config: { permission: { external_directory: "ask" } },
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "generated-uuid",
            baseUrl: "http://127.0.0.1:4096",
            directory: await realpath(process.cwd()),
            status: "running",
            permissions: { external_directory: "read-only", auto_approved: true },
            existing_active_servers: [],
          }),
        },
      ],
    });
    expect(getServer("generated-uuid")).toMatchObject({
      serverId: "generated-uuid",
      baseUrl: "http://127.0.0.1:4096",
    });
  });

  it("stores the canonical server directory and enables session-scoped permission responders", async () => {
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    await fake.getHandler()({ port: undefined });

    expect(createOpencodeClientMock).not.toHaveBeenCalled();
    expect(startPermissionResponderMock).not.toHaveBeenCalled();
    expect(getServer("generated-uuid")).toMatchObject({
      directory: await import("node:fs/promises").then(({ realpath }) => realpath(process.cwd())),
      permissionPolicy: "read-only",
      permissionScopesEnabled: true,
    });
  });

  it("stops registered permission scopes when the server is closed", async () => {
    const close = vi.fn();
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    await fake.getHandler()({ port: undefined });
    killAllServers();

    expect(close).toHaveBeenCalledOnce();
  });

  it("reports the resolved policy back to the caller", async () => {
    getExternalDirectoryPolicyMock.mockReturnValue("deny");
    buildServerConfigMock.mockReturnValue({ permission: { external_directory: "deny" } });
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    const result = await fake.getHandler()({ port: undefined });

    expect(JSON.parse(result.content[0].text).permissions).toEqual({
      external_directory: "deny",
      auto_approved: true,
    });
  });

  it("uses the provided port", async () => {
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:5000", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    await handler({ port: 5000 });

    expect(createOpencodeServerMock).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 5000,
      timeout: 10_000,
      config: { permission: { external_directory: "ask" } },
    });
    expect(createOpencodeServerMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next port when the requested one fails and succeeds there", async () => {
    const close = vi.fn();
    createOpencodeServerMock
      .mockRejectedValueOnce(new Error("Server exited with code 1"))
      .mockResolvedValueOnce({ url: "http://127.0.0.1:4097", close });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(createOpencodeServerMock).toHaveBeenCalledTimes(2);
    const [first, second] = createOpencodeServerMock.mock.calls.map((call) => call[0]);
    expect(first).toMatchObject({ port: 4096 });
    expect(second).toMatchObject({ port: 4097 });
    expect(JSON.parse(result.content[0].text).baseUrl).toBe("http://127.0.0.1:4097");
  });

  it("reports the port walk after every attempted port fails", async () => {
    createOpencodeServerMock
      .mockRejectedValueOnce(new Error("Server exited with code 1"))
      .mockRejectedValueOnce(new Error("Server exited with code 1"))
      .mockRejectedValueOnce(new Error("Server exited with code 1"));
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(createOpencodeServerMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message:
              "Server exited with code 1. Tried ports 4096..4098 and none started; retry with a explicit free 'port' if this persists",
          }),
        },
      ],
    });
  });

  it("lets the external_directory input override the env var and CLI arg", async () => {
    vi.stubEnv("OPENCODE_MCP_EXTERNAL_DIR", "deny");
    process.argv = [...originalArgv, "OPENCODE_MCP_EXTERNAL_DIR=read-only"];
    buildServerConfigMock.mockReturnValue({ permission: { external_directory: "allow" } });
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    const result = await fake.getHandler()({ port: undefined, external_directory: "allow" });

    expect(getExternalDirectoryPolicyMock).not.toHaveBeenCalled();
    expect(buildServerConfigMock).toHaveBeenCalledWith("allow", {
      rootDirectory: await realpath(process.cwd()),
    });
    expect(JSON.parse(result.content[0].text).permissions).toEqual({
      external_directory: "allow",
      auto_approved: true,
    });
  });

  it("reports an external_directory input of deny and passes it to buildServerConfig", async () => {
    buildServerConfigMock.mockReturnValue({ permission: { external_directory: "deny" } });
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    const result = await fake.getHandler()({ port: undefined, external_directory: "deny" });

    expect(buildServerConfigMock).toHaveBeenCalledWith("deny", {
      rootDirectory: await realpath(process.cwd()),
    });
    expect(JSON.parse(result.content[0].text).permissions.external_directory).toBe("deny");
  });

  it("resolves the policy from the env var when no input is given (env beats argv)", async () => {
    vi.stubEnv("OPENCODE_MCP_EXTERNAL_DIR", "allow");
    process.argv = [...originalArgv, "OPENCODE_MCP_EXTERNAL_DIR=deny"];
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    await fake.getHandler()({ port: undefined });

    expect(buildServerConfigMock).toHaveBeenCalledWith("allow", {
      rootDirectory: await realpath(process.cwd()),
    });
  });

  it("resolves the policy from the CLI arg when no input or env var is given", async () => {
    process.argv = [...originalArgv, "OPENCODE_MCP_EXTERNAL_DIR=deny"];
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    await fake.getHandler()({ port: undefined });

    expect(buildServerConfigMock).toHaveBeenCalledWith("deny", {
      rootDirectory: await realpath(process.cwd()),
    });
  });

  it("resolves the realpath before creating the server and stores it on the registry", async () => {
    const directory = await realpath(process.cwd());
    const order: string[] = [];
    realpathMock.mockImplementation(async () => {
      order.push("realpath");
      return directory;
    });
    createOpencodeServerMock.mockImplementation(async () => {
      order.push("create");
      return { url: "http://127.0.0.1:4096", close: vi.fn() };
    });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    await fake.getHandler()({ port: undefined, external_directory: "read-only" });

    expect(order).toEqual(["realpath", "create"]);
    expect(buildServerConfigMock).toHaveBeenCalledWith("read-only", {
      rootDirectory: directory,
    });
    expect(getServer("generated-uuid")).toMatchObject({
      directory,
      permissionPolicy: "read-only",
    });
  });

  it("returns an error result when starting the server throws an Error on every port", async () => {
    createOpencodeServerMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message:
              "boom. Tried ports 4096..4098 and none started; retry with a explicit free 'port' if this persists",
          }),
        },
      ],
    });
  });

  it("returns an error result when starting the server throws a non-Error value", async () => {
    createOpencodeServerMock.mockRejectedValue("string failure");
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "error", message: "string failure" }),
        },
      ],
    });
  });

  it("reports existing active servers from the database", async () => {
    resetDbForTests();
    const now = Date.now();
    getDb()
      .insert(serversTable)
      .values({
        serverId: "existing-srv",
        ownerInstanceId: "other-instance",
        baseUrl: "http://127.0.0.1:4099",
        directory: "/tmp/existing",
        permissionPolicy: "read-only",
        startedAt: now,
        stoppedAt: null,
      })
      .run();

    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    const result = await fake.getHandler()({ port: undefined });

    expect(JSON.parse(result.content[0].text).existing_active_servers).toEqual([
      { base_url: "http://127.0.0.1:4099", port: 4099, directory: "/tmp/existing" },
    ]);

    resetDbForTests();
  });
});

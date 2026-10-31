import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const createOpencodeServerMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-server.js", () => ({
  createOpencodeServer: (...args: unknown[]) => createOpencodeServerMock(...args),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "generated-uuid",
}));

const getExternalDirectoryPolicyMock = vi.fn();
const startPermissionResponderMock = vi.fn();

vi.mock("../../../src/modules/shared/permissions.js", () => ({
  getExternalDirectoryPolicy: () => getExternalDirectoryPolicyMock(),
  startPermissionResponder: (...args: unknown[]) => startPermissionResponderMock(...args),
}));

const { registerOpencodeStartServer } = await import("../../../src/modules/tools/start_server.js");
const { getServer, killAllServers } = await import(
  "../../../src/modules/shared/server-registry.js"
);

describe("opencode_start_server", () => {
  beforeEach(() => {
    createOpencodeServerMock.mockReset();
    getExternalDirectoryPolicyMock.mockReset();
    startPermissionResponderMock.mockReset();
    killAllServers();

    getExternalDirectoryPolicyMock.mockReturnValue("read-only");
    startPermissionResponderMock.mockReturnValue({ stop: vi.fn(), done: Promise.resolve() });
  });

  it("starts a server, registers its private credential, and returns its id", async () => {
    const close = vi.fn();
    createOpencodeServerMock.mockResolvedValue({
      url: "http://127.0.0.1:4096",
      password: "private-password",
      close,
    });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(createOpencodeServerMock).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 4096,
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "generated-uuid",
            baseUrl: "http://127.0.0.1:4096",
            status: "running",
            permissions: { external_directory: "read-only", auto_approved: true },
          }),
        },
      ],
    });
    expect(getServer("generated-uuid")).toMatchObject({
      serverId: "generated-uuid",
      baseUrl: "http://127.0.0.1:4096",
      password: "private-password",
    });
  });

  it("stores the canonical server directory and enables session-scoped permission responders", async () => {
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);

    await fake.getHandler()({ port: undefined });

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
    createOpencodeServerMock.mockResolvedValue({
      url: "http://127.0.0.1:4096",
      password: "private-password",
      close: vi.fn(),
    });
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
    });
  });

  it("returns an error result when starting the server throws an Error", async () => {
    createOpencodeServerMock.mockRejectedValue(new Error("boom"));
    const fake = createFakeMcpServer();
    registerOpencodeStartServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ port: undefined });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "error", message: "boom" }),
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
});

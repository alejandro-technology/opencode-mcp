import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const createOpencodeServerMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: (...args: unknown[]) => createOpencodeServerMock(...args),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "generated-uuid",
}));

const { registerOpencodeStartServer } = await import("../../../src/modules/tools/start_server.js");
const { getServer, killAllServers } = await import("../../../src/modules/shared/server-registry.js");

describe("opencode_start_server", () => {
  beforeEach(() => {
    createOpencodeServerMock.mockReset();
    killAllServers();
  });

  it("starts a server, registers it, and returns its id", async () => {
    const close = vi.fn();
    createOpencodeServerMock.mockResolvedValue({ url: "http://127.0.0.1:4096", close });
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
          }),
        },
      ],
    });
    expect(getServer("generated-uuid")).toEqual({
      serverId: "generated-uuid",
      baseUrl: "http://127.0.0.1:4096",
      close,
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

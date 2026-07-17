import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn().mockResolvedValue(undefined);
const registerToolsMock = vi.fn();
const killAllServersMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function McpServer() {
    return { connect: connectMock };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function StdioServerTransport() {
    return {};
  }),
}));
vi.mock("../src/modules/shared/server-registry.js", () => ({
  killAllServers: killAllServersMock,
}));
vi.mock("../src/modules/tools/index.js", () => ({
  registerTools: registerToolsMock,
}));

describe("index entrypoint", () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    connectMock.mockClear();
    registerToolsMock.mockClear();
    killAllServersMock.mockClear();

    processOnSpy = vi
      .spyOn(process, "on")
      .mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers.set(String(event), handler);
        return process;
      });
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("registers tools, connects the transport, and wires shutdown handlers", async () => {
    await import("../src/index.js");
    // main() is async; flush microtasks
    await Promise.resolve();
    await Promise.resolve();

    expect(registerToolsMock).toHaveBeenCalledOnce();
    expect(connectMock).toHaveBeenCalledOnce();
    expect(handlers.has("SIGHUP")).toBe(true);
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("exit")).toBe(true);
  });

  it("shuts down tracked servers and exits on SIGINT", async () => {
    await import("../src/index.js");
    await Promise.resolve();

    handlers.get("SIGINT")?.("SIGINT");

    expect(killAllServersMock).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("calls killAllServers as a safety net on process exit", async () => {
    await import("../src/index.js");
    await Promise.resolve();

    handlers.get("exit")?.();

    expect(killAllServersMock).toHaveBeenCalled();
  });

  it("logs and exits with code 1 when main() rejects", async () => {
    connectMock.mockRejectedValueOnce(new Error("connect failed"));

    await import("../src/index.js");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith("Fatal error in main():", expect.any(Error));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

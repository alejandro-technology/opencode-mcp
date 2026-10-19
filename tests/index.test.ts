import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn().mockResolvedValue(undefined);
const registerToolsMock = vi.fn();
const killAllServersMock = vi.fn();
const stopRunObserversMock = vi.fn().mockResolvedValue(true);

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
vi.mock("../src/modules/shared/run-observer.js", () => ({
  stopRunObservers: stopRunObserversMock,
}));
vi.mock("../src/modules/tools/index.js", () => ({
  registerTools: registerToolsMock,
}));
// Instructions hit the network on a cold cache; the entrypoint only needs a string.
vi.mock("../src/modules/shared/instructions.js", () => ({
  createDelegateTaskInstructions: vi.fn().mockResolvedValue("instructions"),
}));

/** Let main()'s async chain (instructions -> server -> connect) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("index entrypoint", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    connectMock.mockClear();
    registerToolsMock.mockClear();
    killAllServersMock.mockClear();
    stopRunObserversMock.mockReset().mockResolvedValue(true);

    processOnSpy = vi
      .spyOn(process, "on")
      .mockImplementation((event: string | symbol, handler: (...args: unknown[]) => unknown) => {
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
    await flush();

    expect(registerToolsMock).toHaveBeenCalledOnce();
    expect(connectMock).toHaveBeenCalledOnce();
    expect(handlers.has("SIGHUP")).toBe(true);
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("exit")).toBe(true);
  });

  it("shuts down tracked servers and exits on SIGINT", async () => {
    await import("../src/index.js");
    await flush();

    await handlers.get("SIGINT")?.("SIGINT");

    expect(stopRunObserversMock).toHaveBeenCalledOnce();
    expect(killAllServersMock).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("does not close servers or exit before check-process drain completes", async () => {
    let finishDrain!: (value: boolean) => void;
    stopRunObserversMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishDrain = resolve;
        }),
    );
    await import("../src/index.js");
    await flush();
    const shutdownCall = handlers.get("SIGTERM")?.("SIGTERM");
    expect(killAllServersMock).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
    await handlers.get("SIGINT")?.("SIGINT");
    expect(stopRunObserversMock).toHaveBeenCalledOnce();
    finishDrain(true);
    await shutdownCall;
    expect(killAllServersMock).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("keeps the MCP process and server records alive when check termination is unconfirmed", async () => {
    stopRunObserversMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await import("../src/index.js");
    await flush();
    await handlers.get("SIGINT")?.("SIGINT");
    expect(killAllServersMock).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
    await handlers.get("SIGINT")?.("SIGINT");
    expect(killAllServersMock).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("calls killAllServers as a safety net on process exit", async () => {
    await import("../src/index.js");
    await flush();

    handlers.get("exit")?.();

    expect(killAllServersMock).toHaveBeenCalled();
  });

  it("logs and exits with code 1 when main() rejects", async () => {
    connectMock.mockRejectedValueOnce(new Error("connect failed"));

    await import("../src/index.js");
    await flush();

    expect(consoleErrorSpy).toHaveBeenCalledWith("Fatal error in main():", expect.any(Error));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

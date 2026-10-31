import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  isOpencodeLauncherMain,
  runLauncher,
} from "../../../src/modules/shared/opencode-server-launcher.js";

function serverChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 9876;
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  return child;
}

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe("standalone OpenCode launcher", () => {
  const originalArgv = process.argv;
  const oldPassword = process.env.OPENCODE_SERVER_PASSWORD;
  let signalListeners: Map<NodeJS.Signals, Set<(...args: never[]) => void>>;
  let watchdog: (() => void) | undefined;

  beforeEach(() => {
    process.argv = ["node", "opencode-server-launcher.ts", "127.0.0.1", "4096"];
    process.env.OPENCODE_SERVER_PASSWORD = "launcher-password";
    spawnMock.mockReset();
    signalListeners = new Map(
      (["SIGTERM", "SIGINT"] as const).map((signal) => [
        signal,
        new Set(process.listeners(signal)),
      ]),
    );
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ProcessExit(code ?? 0);
    }) as never);
    vi.stubGlobal("setInterval", (callback: TimerHandler) => {
      watchdog = callback as () => void;
      return { unref: vi.fn() };
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (oldPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = oldPassword;
    for (const [signal, previous] of signalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!previous.has(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("recognizes direct execution from both source and build output", () => {
    expect(isOpencodeLauncherMain("/repo/src/opencode-server-launcher.ts")).toBe(true);
    expect(isOpencodeLauncherMain("/repo/build/opencode-server-launcher.js")).toBe(true);
    expect(isOpencodeLauncherMain("/repo/src/not-the-launcher.ts")).toBe(false);
    expect(isOpencodeLauncherMain(undefined)).toBe(false);
  });

  it("runs when invoked as a source launcher and makes signal shutdown idempotent", async () => {
    const child = serverChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return request.url.endsWith("/api/info")
          ? Response.json({ version: "2.2.1", pid: child.pid })
          : Response.json({ directory: "/tmp" });
      }),
    );
    process.argv = ["node", "/repo/src/opencode-server-launcher.ts", "127.0.0.1", "4096"];
    const previousTerm = new Set(process.listeners("SIGTERM"));
    const previousInt = new Set(process.listeners("SIGINT"));
    await import("../../../src/modules/shared/opencode-server-launcher.js?direct-source-test");
    const termHandler = process.listeners("SIGTERM").find((handler) => !previousTerm.has(handler));
    const intHandler = process.listeners("SIGINT").find((handler) => !previousInt.has(handler));
    expect(termHandler).toBeDefined();
    expect(intHandler).toBeDefined();
    termHandler?.();
    intHandler?.();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => child.emit("exit", null, "SIGTERM")).toThrow(ProcessExit);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("retries omitted version metadata and unauthorized location responses", async () => {
    vi.useFakeTimers();
    const child = serverChild();
    spawnMock.mockReturnValue(child);
    const responses = [
      Response.json({ pid: child.pid }),
      Response.json({ version: "2.2.1", pid: child.pid }),
      new Response("unauthorized", { status: 401 }),
      Response.json({ version: "2.2.1", pid: child.pid }),
      Response.json({ directory: "/tmp" }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = runLauncher();
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("rejects missing arguments and missing private credentials", async () => {
    process.argv = ["node", "opencode-server-launcher.ts"];
    await expect(runLauncher()).rejects.toMatchObject({ code: 2 });
    expect(spawnMock).not.toHaveBeenCalled();

    process.argv = ["node", "opencode-server-launcher.ts", "127.0.0.1", "4096"];
    delete process.env.OPENCODE_SERVER_PASSWORD;
    await expect(runLauncher()).rejects.toMatchObject({ code: 2 });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("authenticates readiness and announces the matching child version", async () => {
    const child = serverChild();
    spawnMock.mockReturnValue(child);
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.url.endsWith("/api/info")
          ? Response.json({ version: "2.2.1", pid: child.pid })
          : Response.json({ directory: "/tmp" });
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await runLauncher();

    expect(spawnMock).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--hostname=127.0.0.1", "--port=4096"],
      expect.objectContaining({
        env: expect.objectContaining({ OPENCODE_SERVER_PASSWORD: "launcher-password" }),
      }),
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/info",
      "/api/location",
    ]);
    const authorization = `Basic ${Buffer.from("opencode:launcher-password").toString("base64")}`;
    for (const request of requests)
      expect(request.headers.get("authorization")).toBe(authorization);
    expect(output).toHaveBeenCalledWith(`ready ${child.pid} 2.2.1`);
    expect(watchdog).toBeDefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["version", { version: "2.1.9", pid: 9876 }, "Unsupported OpenCode CLI version"],
    [
      "process identity",
      { version: "2.2.1", pid: 1 },
      "listener is not the spawned OpenCode server",
    ],
    ["version format", { version: "dev-build", pid: 9876 }, "Unsupported OpenCode CLI version"],
  ])("rejects invalid API %s and stops the child", async (_label, info, message) => {
    const child = serverChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(info)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runLauncher();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits through unhealthy readiness until the bounded deadline", async () => {
    vi.useFakeTimers();
    const child = serverChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = runLauncher();
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(error).toHaveBeenCalledWith(
      "launcher: authenticated OpenCode API not ready after 20000ms",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops on orphaning and handles server error or exit events", async () => {
    const child = serverChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return request.url.endsWith("/api/info")
          ? Response.json({ version: "2.2.1", pid: child.pid })
          : Response.json({ directory: "/tmp" });
      }),
    );
    await runLauncher();
    watchdog?.();
    expect(child.kill).not.toHaveBeenCalled();
    const ppid = vi.spyOn(process, "ppid", "get").mockReturnValue(1);
    expect(() => watchdog?.()).toThrow(ProcessExit);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(process.exit).toHaveBeenCalledWith(0);
    ppid.mockRestore();

    const failedChild = serverChild();
    spawnMock.mockReturnValue(failedChild);
    await runLauncher();
    expect(() => failedChild.emit("error", new Error("spawn failed"))).toThrow(ProcessExit);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(() => failedChild.emit("exit", 7, null)).toThrow(ProcessExit);
    expect(process.exit).toHaveBeenCalledWith(7);
  });
});

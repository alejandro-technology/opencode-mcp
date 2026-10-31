import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const makeMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock("@opencode/client", () => ({
  OpenCode: { make: (...args: unknown[]) => makeMock(...args) },
}));

import {
  createOpencodeServer,
  launcherPathFor,
  opencodeLauncherPath,
} from "../../../src/modules/shared/opencode-server.js";

function launcherChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 43210;
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("OpenCode server launcher", () => {
  const oldPassword = process.env.OPENCODE_SERVER_PASSWORD;
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    makeMock.mockReset();
    process.env.OPENCODE_SERVER_PASSWORD = "launcher-test-password";
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    kill.mockRestore();
    if (oldPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = oldPassword;
    vi.useRealTimers();
  });

  it("selects the TypeScript sibling in source and JavaScript sibling in build output", () => {
    expect(launcherPathFor("file:///repo/src/modules/shared/opencode-server.ts")).toBe(
      "/repo/src/modules/shared/opencode-server-launcher.ts",
    );
    expect(launcherPathFor("file:///repo/build/src/modules/shared/opencode-server.js")).toBe(
      "/repo/build/src/modules/shared/opencode-server-launcher.js",
    );
    expect(opencodeLauncherPath).toMatch(/opencode-server-launcher\.ts$/);
  });

  it("starts the matching launcher and validates authenticated server identity", async () => {
    const child = launcherChild();
    spawnMock.mockReturnValue(child);
    const locationGet = vi.fn().mockResolvedValue({ directory: "/tmp" });
    makeMock.mockReturnValue({
      server: { info: vi.fn().mockResolvedValue({ version: "2.2.1", pid: child.pid }) },
      location: { get: locationGet },
    });
    const start = createOpencodeServer({ hostname: "127.0.0.1", port: 4096 });
    child.stdout.write("launcher is starting\n");
    child.stdout.write(`ready ${child.pid} 2.2.1\n`);

    const server = await start;
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [opencodeLauncherPath, "127.0.0.1", "4096"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "inherit"] }),
    );
    expect(makeMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
      headers: {
        Authorization: `Basic ${Buffer.from("opencode:launcher-test-password").toString("base64")}`,
      },
    });
    expect(locationGet).toHaveBeenCalledWith(undefined, { signal: expect.any(AbortSignal) });
    expect(server).toMatchObject({
      url: "http://127.0.0.1:4096",
      password: "launcher-test-password",
    });
    server.close();
    expect(kill).toHaveBeenCalledWith(child.pid, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    ["unsupported version", { version: "2.1.9", pid: 43210 }, undefined],
    ["wrong process", { version: "2.2.1", pid: 1 }, undefined],
    ["protected readiness failure", { version: "2.2.1", pid: 43210 }, new Error("unauthorized")],
  ])("terminates the owned child after %s", async (_name, info, locationError) => {
    const child = launcherChild();
    spawnMock.mockReturnValue(child);
    makeMock.mockReturnValue({
      server: { info: vi.fn().mockResolvedValue(info) },
      location: { get: vi.fn().mockRejectedValue(locationError ?? new Error("location failed")) },
    });
    const start = createOpencodeServer({ hostname: "127.0.0.1", port: 4096 });
    child.stdout.write(`ready ${child.pid} 2.2.1\n`);
    await expect(start).rejects.toThrow("OpenCode CLI compatibility check failed");
    expect(kill).toHaveBeenCalledWith(child.pid, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("generates a private password when none was configured", async () => {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    const child = launcherChild();
    spawnMock.mockReturnValue(child);
    makeMock.mockReturnValue({
      server: { info: vi.fn().mockResolvedValue({ version: "2.2.5", pid: child.pid }) },
      location: { get: vi.fn().mockResolvedValue({ directory: "/tmp" }) },
    });
    const start = createOpencodeServer({ hostname: "127.0.0.1", port: 4096 });
    child.stdout.write(`ready ${child.pid} 2.2.5\n`);
    const server = await start;
    expect(server.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(spawnMock.mock.calls[0][2].env.OPENCODE_SERVER_PASSWORD).toBe(server.password);
    kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    child.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    expect(() => server.close()).not.toThrow();
  });

  it("rejects launcher errors and premature exits", async () => {
    const erroredChild = launcherChild();
    spawnMock.mockReturnValueOnce(erroredChild);
    const spawnFailure = createOpencodeServer({ hostname: "127.0.0.1", port: 1 });
    erroredChild.emit("error", new Error("cannot spawn"));
    await expect(spawnFailure).rejects.toThrow("cannot spawn");

    const exitedChild = launcherChild();
    spawnMock.mockReturnValueOnce(exitedChild);
    const exitFailure = createOpencodeServer({ hostname: "127.0.0.1", port: 2 });
    exitedChild.emit("exit", 2);
    await expect(exitFailure).rejects.toThrow("launcher exited before readiness (code 2)");
  });

  it("reports a readiness timeout without launcher output", async () => {
    vi.useFakeTimers();
    const child = launcherChild();
    spawnMock.mockReturnValue(child);
    const start = createOpencodeServer({ hostname: "127.0.0.1", port: 4096 });
    const rejection = expect(start).rejects.toThrow("(no launcher output)");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("contains non-Error readiness failures and already-exited kill targets", async () => {
    const child = launcherChild();
    spawnMock.mockReturnValue(child);
    makeMock.mockReturnValue({
      server: { info: vi.fn().mockResolvedValue({ version: "2.2.1", pid: child.pid }) },
      location: { get: vi.fn().mockRejectedValue("unauthorized") },
    });
    kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    child.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    const start = createOpencodeServer({ hostname: "127.0.0.1", port: 4096 });
    child.stdout.write(`ready ${child.pid} 2.2.1\\n`);
    await expect(start).rejects.toThrow("unauthorized");
  });

  it("kills a launcher that does not produce readiness before the deadline", async () => {
    vi.useFakeTimers();
    const child = launcherChild();
    spawnMock.mockReturnValue(child);
    const start = createOpencodeServer({ hostname: "127.0.0.1", port: 4096 });
    child.stdout.write("partial startup output\n");
    const rejection = expect(start).rejects.toThrow("OpenCode server not ready after 25000ms");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

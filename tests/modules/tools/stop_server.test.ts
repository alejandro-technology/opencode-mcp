import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  releaseWorkspace,
  reserveWorkspace,
  runCheck,
} from "../../../src/modules/shared/execution-report.js";
import {
  getServer,
  killAllServers,
  registerServer,
} from "../../../src/modules/shared/server-registry.js";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { registerOpencodeStopServer } from "../../../src/modules/tools/stop_server.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

describe("opencode_stop_server", () => {
  beforeEach(() => {
    killAllServers();
  });

  it("returns not_found for an unknown server", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeStopServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ server_id: "missing", status: "not_found" }) },
      ],
    });
  });

  it("closes and removes a known server", async () => {
    const close = vi.fn();
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close });
    const fake = createFakeMcpServer();
    registerOpencodeStopServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(close).toHaveBeenCalledOnce();
    expect(getServer("srv-1")).toBeUndefined();
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ server_id: "srv-1", status: "stopped" }) }],
    });
  });

  it("does not close or unregister a server when a check process has not drained", async () => {
    const stopObservers = vi.fn().mockResolvedValue(false);
    vi.resetModules();
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({
      stopServerObservers: stopObservers,
    }));
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tool = await import("../../../src/modules/tools/stop_server.js");
    const close = vi.fn();
    registry.registerServer({ serverId: "stuck-check", baseUrl: "http://localhost", close });
    const fake = createFakeMcpServer();
    tool.registerOpencodeStopServer(fake.server);
    const payload = JSON.parse(
      (await fake.getHandler()({ server_id: "stuck-check" })).content[0].text,
    );
    expect(payload.status).toBe("cleanup_pending");
    expect(close).not.toHaveBeenCalled();
    expect(registry.getServer("stuck-check")).toBeDefined();
    expect(stopObservers).toHaveBeenCalledWith("stuck-check");
    registry.killAllServers();
    vi.doUnmock("../../../src/modules/shared/run-observer.js");
    vi.resetModules();
  });

  it("awaits a SIGTERM-resistant check before closing a server or releasing its workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stop-server-check-drain-"));
    const lease = await reserveWorkspace(directory, true);
    if (!lease) throw new Error("expected workspace lease");
    const controller = new AbortController();
    const run = runCheck(
      {
        executable: process.execPath,
        argv: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        timeout_ms: 10_000,
      },
      directory,
      controller.signal,
    );
    let checkSettled = false;
    const observedRun = run.then((value) => {
      checkSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    registerTask({
      taskId: "stop-check-task",
      serverId: "srv-check",
      sessionId: "session-check",
      directory,
      currentRunId: "run-check",
      runs: [
        {
          run_id: "run-check",
          message_id: "msg-check",
          startedAt: 1,
          controller,
          workspaceLease: lease,
        },
      ],
    });
    const close = vi.fn(() => {
      expect(checkSettled).toBe(true);
    });
    registerServer({ serverId: "srv-check", baseUrl: "http://127.0.0.1:4096", directory, close });
    const fake = createFakeMcpServer();
    registerOpencodeStopServer(fake.server);

    const result = await fake.getHandler()({ server_id: "srv-check" });
    const checkResult = await observedRun;
    if (JSON.parse(result.content[0].text).status !== "stopped")
      console.log("check-result", checkResult);
    expect(JSON.parse(result.content[0].text).status).toBe("stopped");
    expect(checkSettled).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(getServer("srv-check")).toBeUndefined();
    const acquired = await reserveWorkspace(directory, true);
    expect(acquired).toBeDefined();
    if (!acquired) throw new Error("stopped server should release the drained run lease");
    releaseWorkspace(acquired);
    removeTask("stop-check-task");
    await rm(directory, { recursive: true, force: true });
  });
});

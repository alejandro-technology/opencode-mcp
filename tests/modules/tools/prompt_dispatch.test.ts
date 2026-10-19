import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const directories: string[] = [];

async function setupHandlers(fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-dispatch-test-"));
  directories.push(directory);
  vi.stubGlobal("fetch", fetch);
  vi.resetModules();
  vi.doMock("../../../src/modules/shared/run-observer.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../src/modules/shared/run-observer.js")>()),
    observeRun: vi.fn(),
  }));
  const [servers, tasks, execution, startModule, continueModule, cancelModule] = await Promise.all([
    import("../../../src/modules/shared/server-registry.js"),
    import("../../../src/modules/shared/task-registry.js"),
    import("../../../src/modules/shared/execution-report.js"),
    import("../../../src/modules/tools/start_task.js"),
    import("../../../src/modules/tools/continue_task.js"),
    import("../../../src/modules/tools/cancel_task.js"),
  ]);
  servers.registerServer({
    serverId: "dispatch-server",
    baseUrl: "http://127.0.0.1:43219",
    directory,
    close: vi.fn(),
  });
  const startServer = createFakeMcpServer();
  const continueServer = createFakeMcpServer();
  const cancelServer = createFakeMcpServer();
  startModule.registerOpencodeStartTask(startServer.server);
  continueModule.registerOpencodeContinueTask(continueServer.server);
  cancelModule.registerOpencodeCancelTask(cancelServer.server);
  return {
    directory,
    startServer,
    continueServer,
    cancelServer,
    servers,
    tasks,
    execution,
  };
}

function response(status: number, value: unknown) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../../src/modules/shared/run-observer.js");
  vi.resetModules();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("prompt dispatch acknowledgement resolution over the real SDK", () => {
  it("keeps the accepted writer task and exclusive lease when the ACK socket is lost", async () => {
    let writerActive = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/session" && request.method === "POST")
        return response(200, { id: "session-1" });
      if (pathname.endsWith("/prompt_async")) {
        writerActive = true;
        throw new TypeError("fetch failed after server acceptance");
      }
      if (pathname.endsWith("/abort")) return response(200, true);
      return response(404, { message: `unexpected ${pathname}` });
    });
    const { directory, startServer, tasks, execution, servers, cancelServer } =
      await setupHandlers(fetchMock);
    const start = startServer.getHandler();
    const uncertain = await start({
      server_id: "dispatch-server",
      prompt: "write the fixture",
      expected_changes: [{ path: "output.txt", change: "created" }],
    });
    const payload = JSON.parse(uncertain.content[0].text);
    expect(writerActive).toBe(true);
    expect(payload).toMatchObject({
      status: "dispatch_uncertain",
      task_id: expect.any(String),
      run_id: expect.any(String),
      dispatch: { state: "uncertain", error: "fetch failed after server acceptance" },
    });
    const task = tasks.getTask(payload.task_id);
    expect(task?.runs?.[0]).toMatchObject({
      run_id: payload.run_id,
      dispatchState: "uncertain",
      dispatchError: "fetch failed after server acceptance",
    });
    expect(task?.runs?.[0].workspaceLease).toBeDefined();
    expect(await execution.reserveWorkspace(directory, true)).toBeUndefined();
    expect(await execution.reserveWorkspace(directory, false)).toBeUndefined();

    const ordinaryWriter = await start({ server_id: "dispatch-server", prompt: "ordinary writer" });
    expect(JSON.parse(ordinaryWriter.content[0].text).status).toBe("workspace_busy");
    expect(
      fetchMock.mock.calls.filter(([request]) =>
        new URL(request.url).pathname.endsWith("/prompt_async"),
      ),
    ).toHaveLength(1);

    const cancelled = await cancelServer.getHandler()({ task_id: payload.task_id });
    expect(JSON.parse(cancelled.content[0].text).status).toBe("cancelled");
    expect(tasks.getTask(payload.task_id)?.runs?.[0].reportReady).toBe(true);
    const released = await execution.reserveWorkspace(directory, true);
    expect(released).toBeDefined();
    if (!released) throw new Error("expected released workspace lease");
    execution.releaseWorkspace(released);
    servers.removeServer("dispatch-server");
  });

  it("rolls back definite HTTP rejection and treats 5xx plus abort-ack loss as uncertain", async () => {
    let promptStatus = 400;
    let abortTransportFails = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/session" && request.method === "POST")
        return response(200, { id: "session-1" });
      if (pathname.endsWith("/prompt_async"))
        return promptStatus === 204
          ? new Response(null, { status: 204 })
          : response(promptStatus, { message: "rejected" });
      if (pathname.endsWith("/abort")) {
        if (abortTransportFails) throw new TypeError("abort ACK lost");
        return response(200, true);
      }
      return response(404, { message: `unexpected ${pathname}` });
    });
    const { directory, startServer, tasks, execution, servers, cancelServer } =
      await setupHandlers(fetchMock);
    const start = startServer.getHandler();
    const rejected = await start({
      server_id: "dispatch-server",
      prompt: "must be rejected",
      checks: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
    });
    expect(JSON.parse(rejected.content[0].text)).toMatchObject({
      status: "prompt_rejected",
      http_status: 400,
    });
    expect(tasks.getTask(JSON.parse(rejected.content[0].text).task_id)).toBeUndefined();
    const freeAfterRejection = await execution.reserveWorkspace(directory, true);
    expect(freeAfterRejection).toBeDefined();
    if (!freeAfterRejection) throw new Error("expected lease rollback after rejection");
    execution.releaseWorkspace(freeAfterRejection);

    promptStatus = 500;
    const uncertain = JSON.parse(
      (
        await start({
          server_id: "dispatch-server",
          prompt: "server may have accepted",
          checks: [{ executable: process.execPath, argv: [] }],
        })
      ).content[0].text,
    );
    expect(uncertain.status).toBe("dispatch_uncertain");
    expect(tasks.getTask(uncertain.task_id)?.runs?.[0].dispatchState).toBe("uncertain");
    abortTransportFails = true;
    const abortError = await cancelServer.getHandler()({ task_id: uncertain.task_id });
    expect(JSON.parse(abortError.content[0].text).status).toBe("error");
    expect(tasks.getTask(uncertain.task_id)?.runs?.[0].workspaceLease).toBeDefined();
    expect(await execution.reserveWorkspace(directory, true)).toBeUndefined();
    servers.removeServer("dispatch-server");
  });

  it("preserves prior cancellation/history on a 4xx continuation rejection and tracks a lost continuation ACK", async () => {
    let promptMode: "reject" | "lost" = "reject";
    let abortFails = false;
    const fetchMock = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/prompt_async")) {
        if (promptMode === "reject") return response(409, { message: "session busy" });
        throw new TypeError("continuation ACK lost after acceptance");
      }
      if (pathname.endsWith("/abort")) {
        if (abortFails) throw new TypeError("abort ACK lost");
        return response(200, true);
      }
      return response(404, { message: `unexpected ${pathname}` });
    });
    const { directory, continueServer, cancelServer, servers, tasks, execution } =
      await setupHandlers(fetchMock);
    tasks.registerTask({
      taskId: "history-task",
      serverId: "dispatch-server",
      sessionId: "session-1",
      directory,
      currentRunId: "old-run",
      cancelledAt: 123,
      runs: [
        {
          run_id: "old-run",
          message_id: "msg-old",
          startedAt: 1,
          cancelledAt: 123,
          reportReady: true,
          executionState: "cancelled",
          report: {
            changes: [],
            verification: { state: "cancelled", checks: [], execution_state: "cancelled" },
            diagnostics: [],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: true,
              errors: [],
              attribution: "uncertain_shared_workspace",
            },
          },
          result: {
            task_id: "history-task",
            run_id: "old-run",
            status: "cancelled",
            result: "old output",
          },
        },
      ],
    });
    const continuation = continueServer.getHandler();
    const rejected = JSON.parse(
      (
        await continuation({
          task_id: "history-task",
          prompt: "reject this followup",
          checks: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
        })
      ).content[0].text,
    );
    expect(rejected).toMatchObject({ status: "prompt_rejected", http_status: 409 });
    expect(tasks.getTask("history-task")?.currentRunId).toBe("old-run");
    expect(tasks.getTask("history-task")?.cancelledAt).toBe(123);
    expect(tasks.getTask("history-task")?.runs).toHaveLength(1);
    const freeAfterReject = await execution.reserveWorkspace(directory, true);
    expect(freeAfterReject).toBeDefined();
    if (!freeAfterReject) throw new Error("expected continuation lease rollback");
    execution.releaseWorkspace(freeAfterReject);

    promptMode = "lost";
    const uncertain = JSON.parse(
      (
        await continuation({
          task_id: "history-task",
          prompt: "this continuation was accepted but its ACK was lost",
          expected_changes: [{ path: "followup.txt", change: "created" }],
        })
      ).content[0].text,
    );
    expect(uncertain).toMatchObject({
      status: "dispatch_uncertain",
      dispatch: { state: "uncertain", error: "continuation ACK lost after acceptance" },
    });
    const current = tasks.getTask("history-task");
    expect(current?.currentRunId).toBe(uncertain.run_id);
    expect(current?.cancelledAt).toBeUndefined();
    expect(current?.runs).toHaveLength(2);
    expect(current?.runs?.[0].result?.result).toBe("old output");
    expect(current?.runs?.[1].workspaceLease).toBeDefined();
    expect(await execution.reserveWorkspace(directory, true)).toBeUndefined();

    abortFails = true;
    const abortResult = await cancelServer.getHandler()({ task_id: "history-task" });
    expect(JSON.parse(abortResult.content[0].text).status).toBe("error");
    expect(current?.runs?.[1].workspaceLease).toBeDefined();
    expect(await execution.reserveWorkspace(directory, false)).toBeUndefined();
    tasks.removeTask("history-task");
    servers.removeServer("dispatch-server");
  });
});

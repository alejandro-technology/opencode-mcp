import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCode } from "@opencode/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => {
    const resolved = clientForTaskMock(...args);
    if (!resolved) return resolved;
    const session = resolved.client.session ?? {};
    return {
      ...resolved,
      client: {
        ...resolved.client,
        session: {
          ...session,
          active: session.active ?? vi.fn().mockResolvedValue({}),
          inbox: session.inbox ?? { cancel: vi.fn().mockResolvedValue(undefined) },
        },
      },
    };
  },
}));

const { registerOpencodeCancelTask } = await import("../../../src/modules/tools/cancel_task.js");
const { getTask, registerTask, removeTask } = await import(
  "../../../src/modules/shared/task-registry.js"
);
const { releaseWorkspace, reserveWorkspace } = await import(
  "../../../src/modules/shared/execution-report.js"
);

describe("opencode_cancel_task", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    removeTask("task-1");
  });

  it("returns task_not_found when the task cannot be resolved", async () => {
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_id: "missing", status: "task_not_found" }) },
      ],
    });
  });

  it("waits for CLI2 writer cleanup before marking cancellation or releasing its lease", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-idle-gate-"));
    const lease = await reserveWorkspace(directory, true);
    if (!lease) throw new Error("expected workspace lease");
    registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      directory,
      currentRunId: "run-1",
      runs: [
        {
          run_id: "run-1",
          message_id: "message-1",
          inboxId: "inbox-1",
          startedAt: 1,
          workspaceLease: lease,
        },
      ],
    });
    const activeCall = vi.fn(() => new Promise((resolve) => (releaseActive = resolve)));
    let releaseActive!: (value: Record<string, unknown>) => void;
    const inboxCancel = vi.fn().mockRejectedValue(new Error("inbox already delivered"));
    clientForTaskMock.mockReturnValue({
      client: {
        session: {
          interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
          active: activeCall,
          inbox: { cancel: inboxCancel },
        },
      },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const pending = fake.getHandler()({ task_id: "task-1" });
    await vi.waitFor(() => expect(activeCall).toHaveBeenCalledOnce());
    expect(inboxCancel).toHaveBeenCalledWith({ sessionID: "session-1", inboxID: "inbox-1" });
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    expect(await reserveWorkspace(directory, true)).toBeUndefined();

    releaseActive({});
    const result = await pending;
    expect(JSON.parse(result.content[0].text).status).toBe("cancelled");
    expect(getTask("task-1")?.cancelledAt).toBeTypeOf("number");
    const released = await reserveWorkspace(directory, true);
    expect(released).toBeDefined();
    if (released) releaseWorkspace(released);
    removeTask("task-1");
    await rm(directory, { recursive: true, force: true });
  });

  it("retains the task and workspace lease when CLI2 accepts but never becomes idle", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-timeout-gate-"));
    const lease = await reserveWorkspace(directory, true);
    if (!lease) throw new Error("expected workspace lease");
    registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      directory,
      currentRunId: "run-1",
      runs: [{ run_id: "run-1", message_id: "message-1", startedAt: 1, workspaceLease: lease }],
    });
    clientForTaskMock.mockReturnValue({
      client: {
        session: {
          interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
          active: vi.fn().mockResolvedValue({ "session-1": { type: "running" } }),
        },
      },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const pending = fake.getHandler()({ task_id: "task-1" });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(JSON.parse(result.content[0].text).status).toBe("cancellation_pending");
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    expect(getTask("task-1")?.runs?.[0].workspaceLease).toBe(lease);
    expect(await reserveWorkspace(directory, true)).toBeUndefined();
    removeTask("task-1");
    await rm(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("retains cancellation state when queued inbox cancellation is rejected", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      currentRunId: "run-1",
      runs: [{ run_id: "run-1", message_id: "message-1", inboxId: "inbox-1", startedAt: 1 }],
    });
    clientForTaskMock.mockReturnValue({
      client: {
        session: {
          interrupt: vi.fn().mockResolvedValue({ interrupted: false }),
          inbox: { cancel: vi.fn().mockRejectedValue(new Error("cancel refused")) },
          active: vi.fn().mockResolvedValue({}),
        },
      },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const result = await fake.getHandler()({ task_id: "task-1" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "error",
      message: "cancel refused",
    });
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    removeTask("task-1");
  });

  it("aborts the session and returns cancelled status", async () => {
    const interrupt = vi.fn().mockResolvedValue({ interrupted: true });
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(interrupt).toHaveBeenCalledWith({ sessionID: "session-1", resume: false });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "task-1",
            session_id: "session-1",
            status: "cancelled",
          }),
        },
      ],
    });
  });

  it("records cancelledAt on the registry record", async () => {
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt: vi.fn().mockResolvedValue({ interrupted: true }) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);

    await fake.getHandler()({ task_id: "task-1" });

    expect(getTask("task-1")?.cancelledAt).toBeTypeOf("number");
    removeTask("task-1");
  });

  it("does not record cancelledAt when the abort itself fails", async () => {
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt: vi.fn().mockRejectedValue(new Error("nope")) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);

    await fake.getHandler()({ task_id: "task-1" });

    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    removeTask("task-1");
  });

  it("rejects cancellation while another dispatch owns the task reservation", async () => {
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    tasks.registerTask({ taskId: "task-1", serverId: "srv", sessionId: "session-1" });
    tasks.reserveTaskDispatch("task-1");
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt: vi.fn() } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);

    const result = await fake.getHandler()({ task_id: "task-1" });

    expect(result).toMatchObject({ isError: true });
    tasks.releaseTaskDispatch("task-1");
    removeTask("task-1");
  });

  it("does not record cancelledAt when the SDK returns an HTTP error", async () => {
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt: vi.fn().mockRejectedValue(new Error("HTTP 500")) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);

    const result = await fake.getHandler()({ task_id: "task-1" });

    expect(result).toMatchObject({ isError: true });
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    removeTask("task-1");
  });

  it.each([
    false,
    undefined,
  ])("does not confirm cancellation when interrupt returns %s", async (result) => {
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
    const interrupt = vi.fn().mockResolvedValue({ interrupted: result });
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);
    expect(payload).toMatchObject({
      status: "cancellation_not_confirmed",
      message: expect.stringContaining("workspace lease are retained"),
    });
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    removeTask("task-1");
  });

  it("interprets interrupt booleans using the v2 SDK response and keeps a false-interrupt lease", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-sdk-response-"));
    const lease = await reserveWorkspace(directory, true);
    if (!lease) throw new Error("expected workspace lease");
    registerTask({
      taskId: "task-1",
      serverId: "srv-1",
      sessionId: "session-1",
      directory,
      currentRunId: "run-1",
      runs: [
        {
          run_id: "run-1",
          message_id: "msg-run-1",
          startedAt: 1,
          workspaceLease: lease,
          controller: new AbortController(),
        },
      ],
    });
    const requests: Request[] = [];
    const abortValue = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/active"))
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (pathname.includes("/inbox/")) return new Response(null, { status: 204 });
      expect(pathname).toBe("/api/session/session-1/interrupt");
      expect(new URL(request.url).searchParams.get("resume")).toBe("false");
      return new Response(JSON.stringify({ interrupted: abortValue }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = OpenCode.make({ baseUrl: "http://127.0.0.1:43219", fetch });
    clientForTaskMock.mockReturnValue({ client, sessionId: "session-1" });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const confirmed = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);
    expect(confirmed.status).toBe("cancelled");
    expect(
      requests.some((request) => new URL(request.url).pathname.includes("/inbox/msg-run-1")),
    ).toBe(true);
    expect(getTask("task-1")?.cancelledAt).toBeTypeOf("number");
    const released = await reserveWorkspace(directory, true);
    expect(released).toBeDefined();
    if (!released) throw new Error("confirmed cancellation should release the lease");
    releaseWorkspace(released);
    removeTask("task-1");
    await rm(directory, { recursive: true, force: true });
  });

  it("returns an error result when the SDK throws an Error", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt: vi.fn().mockRejectedValue(new Error("db down")) } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "db down" }),
        },
      ],
    });
  });

  it("returns an error result when the SDK throws a non-Error value", async () => {
    clientForTaskMock.mockReturnValue({
      client: { session: { interrupt: vi.fn().mockRejectedValue("weird") } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "weird" }),
        },
      ],
    });
  });
});

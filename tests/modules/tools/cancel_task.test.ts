import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();

vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
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

  it("aborts the session and returns cancelled status", async () => {
    const abort = vi.fn().mockResolvedValue({ data: true });
    clientForTaskMock.mockReturnValue({
      client: { session: { abort } },
      sessionId: "session-1",
    });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(abort).toHaveBeenCalledWith({ path: { id: "session-1" } });
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
      client: { session: { abort: vi.fn().mockResolvedValue({ data: true }) } },
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
      client: { session: { abort: vi.fn().mockRejectedValue(new Error("nope")) } },
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
      client: { session: { abort: vi.fn() } },
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
      client: { session: { abort: vi.fn().mockResolvedValue({ error: { message: "HTTP 500" } }) } },
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
    ["false", { data: false }],
    ["missing", {}],
    ["undefined", undefined],
  ])("does not confirm cancellation when abort returns %s without true data", async (_label, result) => {
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });
    const abort = vi.fn().mockResolvedValue(result);
    clientForTaskMock.mockReturnValue({ client: { session: { abort } }, sessionId: "session-1" });
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

  it("interprets abort booleans using the real SDK response shape and keeps a false-abort lease", async () => {
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
    let abortValue: boolean | null = false;
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/session/session-1/abort");
      return new Response(JSON.stringify(abortValue), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:43219", fetch });
    clientForTaskMock.mockReturnValue({ client, sessionId: "session-1" });
    const fake = createFakeMcpServer();
    registerOpencodeCancelTask(fake.server);
    const handler = fake.getHandler();

    const declined = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);
    expect(declined.status).toBe("cancellation_not_confirmed");
    expect(getTask("task-1")?.cancelledAt).toBeUndefined();
    expect(getTask("task-1")?.runs?.[0].workspaceLease).toBe(lease);
    expect(await reserveWorkspace(directory, true)).toBeUndefined();

    abortValue = true;
    const confirmed = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);
    expect(confirmed.status).toBe("cancelled");
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
      client: { session: { abort: vi.fn().mockRejectedValue(new Error("db down")) } },
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
      client: { session: { abort: vi.fn().mockRejectedValue("weird") } },
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, getInstanceId, resetDbForTests } from "../../../src/modules/shared/db/index.js";
import { servers as serversTable, taskRuns, tasks } from "../../../src/modules/shared/db/schema.js";
import { registerOpencodeListServers } from "../../../src/modules/tools/list_servers.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

describe("opencode_list_servers", () => {
  beforeEach(() => {
    resetDbForTests();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetDbForTests();
    vi.unstubAllGlobals();
  });

  it("returns an empty listing when no servers are known", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const result = await handler({});

    expect(JSON.parse(result.content[0].text)).toEqual({
      servers: [],
      active_count: 0,
      total_count: 0,
    });
  });

  it("lists a registered server as owned, active, and alive", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { registerServer, killAllServers } = await import(
      "../../../src/modules/shared/server-registry.js"
    );
    killAllServers();
    registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/tmp/work",
      permissionPolicy: "read-only",
      close: vi.fn(),
    });

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.total_count).toBe(1);
    expect(parsed.active_count).toBe(1);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({
      server_id: "srv-1",
      base_url: "http://127.0.0.1:4096",
      port: 4096,
      directory: "/tmp/work",
      permission_policy: "read-only",
      owned_by_this_process: true,
      stopped: false,
      alive: true,
      tasks_total: 0,
      sessions_total: 0,
      tasks_active: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4096",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    killAllServers();
  });

  it("marks a stopped server as not alive with reason 'stopped' and does not probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { registerServer, killAllServers } = await import(
      "../../../src/modules/shared/server-registry.js"
    );
    killAllServers();
    registerServer({
      serverId: "srv-stopped",
      baseUrl: "http://127.0.0.1:4097",
      directory: "/tmp/work",
      close: vi.fn(),
    });
    killAllServers();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.active_count).toBe(0);
    expect(parsed.total_count).toBe(1);
    expect(parsed.servers[0]).toMatchObject({
      server_id: "srv-stopped",
      stopped: true,
      alive: false,
      reason: "stopped",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports alive:false with the fetch error reason when the probe fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    getDb()
      .insert(serversTable)
      .values({
        serverId: "srv-dead",
        ownerInstanceId: getInstanceId(),
        baseUrl: "http://127.0.0.1:4098",
        directory: "/tmp/work",
        permissionPolicy: "read-only",
        startedAt: Date.now(),
        stoppedAt: null,
      })
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers[0]).toMatchObject({
      server_id: "srv-dead",
      stopped: false,
      alive: false,
      reason: "connection refused",
    });
  });

  it("treats any HTTP response as alive", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    getDb()
      .insert(serversTable)
      .values({
        serverId: "srv-500",
        ownerInstanceId: getInstanceId(),
        baseUrl: "http://127.0.0.1:4099",
        directory: "/tmp/work",
        permissionPolicy: "read-only",
        startedAt: Date.now(),
        stoppedAt: null,
      })
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers[0].alive).toBe(true);
  });

  it("reports alive:false with a string reason when fetch throws a non-Error", async () => {
    const fetchMock = vi.fn().mockRejectedValue("boom");
    vi.stubGlobal("fetch", fetchMock);

    getDb()
      .insert(serversTable)
      .values({
        serverId: "srv-nondead",
        ownerInstanceId: getInstanceId(),
        baseUrl: "http://127.0.0.1:4100",
        directory: "/tmp/work",
        permissionPolicy: "read-only",
        startedAt: Date.now(),
        stoppedAt: null,
      })
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers[0]).toMatchObject({ alive: false, reason: "boom" });
  });

  it("computes task aggregates (active vs cancelled vs finalized)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const serverId = "srv-agg";
    getDb()
      .insert(serversTable)
      .values({
        serverId,
        ownerInstanceId: getInstanceId(),
        baseUrl: "http://127.0.0.1:4101",
        directory: "/tmp/work",
        permissionPolicy: "read-only",
        startedAt: Date.now(),
        stoppedAt: null,
      })
      .run();

    const now = Date.now();
    const runActive = "run-active";
    const runFinalized = "run-finalized";
    const runCancelled = "run-cancelled";

    getDb()
      .insert(tasks)
      .values([
        {
          taskId: "task-cancelled",
          serverId,
          sessionId: "session-cancelled",
          currentRunId: null,
          createdAt: now,
          startedAt: now,
          cancelledAt: now,
        },
        {
          taskId: "task-norun",
          serverId,
          sessionId: "session-norun",
          currentRunId: null,
          createdAt: now,
          startedAt: now,
          cancelledAt: null,
        },
        {
          taskId: "task-finalized",
          serverId,
          sessionId: "session-finalized",
          currentRunId: runFinalized,
          createdAt: now,
          startedAt: now,
          cancelledAt: null,
        },
        {
          taskId: "task-runcancelled",
          serverId,
          sessionId: "session-runcancelled",
          currentRunId: runCancelled,
          createdAt: now,
          startedAt: now,
          cancelledAt: null,
        },
        {
          taskId: "task-active",
          serverId,
          sessionId: "session-active",
          currentRunId: runActive,
          createdAt: now,
          startedAt: now,
          cancelledAt: null,
        },
        {
          taskId: "task-missingrun",
          serverId,
          sessionId: "session-missingrun",
          currentRunId: "run-does-not-exist",
          createdAt: now,
          startedAt: now,
          cancelledAt: null,
        },
      ])
      .run();

    getDb()
      .insert(taskRuns)
      .values([
        {
          runId: runFinalized,
          taskId: "task-finalized",
          messageId: "msg-finalized",
          startedAt: now,
          finalizedAt: now,
          dispatchState: "accepted",
        },
        {
          runId: runCancelled,
          taskId: "task-runcancelled",
          messageId: "msg-cancelled",
          startedAt: now,
          cancelledAt: now,
          dispatchState: "accepted",
        },
        {
          runId: runActive,
          taskId: "task-active",
          messageId: "msg-active",
          startedAt: now,
          dispatchState: "accepted",
        },
      ])
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);
    const entry = parsed.servers[0];

    expect(entry.tasks_total).toBe(6);
    expect(entry.sessions_total).toBe(6);
    expect(entry.tasks_active).toBe(1);
  });

  it("marks owned_by_this_process false for rows owned by another instance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    getDb()
      .insert(serversTable)
      .values({
        serverId: "srv-other",
        ownerInstanceId: "other-instance",
        baseUrl: "http://127.0.0.1:4102",
        directory: "/tmp/work",
        permissionPolicy: "allow",
        startedAt: Date.now(),
        stoppedAt: null,
      })
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers[0]).toMatchObject({
      owned_by_this_process: false,
      permission_policy: "allow",
    });
  });

  it("orders rows by started_at", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    getDb()
      .insert(serversTable)
      .values([
        {
          serverId: "srv-late",
          ownerInstanceId: getInstanceId(),
          baseUrl: "http://127.0.0.1:4103",
          directory: "/tmp/work",
          permissionPolicy: "read-only",
          startedAt: now + 100,
          stoppedAt: null,
        },
        {
          serverId: "srv-early",
          ownerInstanceId: getInstanceId(),
          baseUrl: "http://127.0.0.1:4104",
          directory: "/tmp/work",
          permissionPolicy: "read-only",
          startedAt: now,
          stoppedAt: null,
        },
      ])
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers.map((s: { server_id: string }) => s.server_id)).toEqual([
      "srv-early",
      "srv-late",
    ]);
  });

  it("runs probes in parallel without aborting on one failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error("nope"));
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    getDb()
      .insert(serversTable)
      .values([
        {
          serverId: "srv-ok",
          ownerInstanceId: getInstanceId(),
          baseUrl: "http://127.0.0.1:4105",
          directory: "/tmp/work",
          permissionPolicy: "read-only",
          startedAt: now,
          stoppedAt: null,
        },
        {
          serverId: "srv-bad",
          ownerInstanceId: getInstanceId(),
          baseUrl: "http://127.0.0.1:4106",
          directory: "/tmp/work",
          permissionPolicy: "read-only",
          startedAt: now + 1,
          stoppedAt: null,
        },
      ])
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers.find((s: { server_id: string }) => s.server_id === "srv-ok").alive).toBe(
      true,
    );
    expect(parsed.servers.find((s: { server_id: string }) => s.server_id === "srv-bad").alive).toBe(
      false,
    );
  });

  it("covers permission_policy deny passthrough", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    getDb()
      .insert(serversTable)
      .values({
        serverId: "srv-deny",
        ownerInstanceId: getInstanceId(),
        baseUrl: "http://127.0.0.1:4107",
        directory: "/tmp/work",
        permissionPolicy: "deny",
        startedAt: Date.now(),
        stoppedAt: null,
      })
      .run();

    const fake = createFakeMcpServer();
    registerOpencodeListServers(fake.server);
    const handler = fake.getHandler();

    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.servers[0].permission_policy).toBe("deny");
  });
});

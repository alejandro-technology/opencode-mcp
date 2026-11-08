import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }));
vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => clientFactory(...args),
}));

const {
  CHILD_POLL_MS,
  registerPermissionSession,
  stopPermissionScope,
  stopPermissionScopesForServer,
  unregisterPermissionSession,
} = await import("../../../src/modules/shared/permission-scopes.js");
const { registerServer, removeServer } = await import(
  "../../../src/modules/shared/server-registry.js"
);

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [] }),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  stopPermissionScopesForServer("scope-server");
  stopPermissionScopesForServer("other-server");
  removeServer("scope-server");
  removeServer("scope-server-extra");
  clientFactory.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A stubbed client's `session.children` that reports no children by default. */
function noChildren() {
  return vi.fn(async () => ({ data: [] }));
}

function controllableStream() {
  const queue: unknown[] = [];
  let resolveNext: ((event: unknown) => void) | undefined;
  return {
    push(event: unknown) {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve(event);
        return;
      }
      queue.push(event);
    },
    stream: (async function* () {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        yield await new Promise<unknown>((resolve) => {
          resolveNext = resolve;
        });
      }
    })(),
  };
}

describe("directory-scoped permission responders", () => {
  it("uses one directory-bound responder per scope and answers only its owned sessions", async () => {
    const replies: unknown[] = [];
    const subscribe = vi.fn(async () => ({
      stream: (async function* () {
        yield {
          type: "permission.asked",
          properties: { id: "foreign", sessionID: "other", permission: "bash" },
        };
        yield {
          type: "permission.asked",
          properties: { id: "mine", sessionID: "owned-1", permission: "bash" },
        };
        yield {
          type: "permission.asked",
          properties: { id: "also-mine", sessionID: "owned-2", permission: "bash" },
        };
      })(),
    }));
    clientFactory.mockReturnValue({
      event: { subscribe },
      session: { children: noChildren() },
      postSessionIdPermissionsPermissionId: vi.fn(async (request) => {
        replies.push(request);
        return {};
      }),
    });
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      permissionPolicy: "allow",
      permissionScopesEnabled: true,
      close: () => {},
    });

    registerPermissionSession("scope-server", "/worktree/one", "owned-1");
    registerPermissionSession("scope-server", "/worktree/one", "owned-2");
    registerPermissionSession("scope-server", "/worktree/two", "owned-3");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ directory: "/worktree/one" }),
      expect.objectContaining({ directory: "/worktree/two" }),
    ]);
    expect(replies).toEqual([
      { path: { id: "owned-1", permissionID: "mine" }, body: { response: "always" } },
      { path: { id: "owned-2", permissionID: "also-mine" }, body: { response: "always" } },
    ]);
    unregisterPermissionSession("scope-server", "/worktree/one", "owned-1");
    unregisterPermissionSession("scope-server", "/worktree/one", "unknown-session");
    unregisterPermissionSession("scope-server", "/worktree/one", "owned-2");
    stopPermissionScope("scope-server", "/worktree/one");
    stopPermissionScopesForServer("scope-server");
  });

  it("aborts a blocked event subscription when its final session is unregistered", async () => {
    let receivedSignal: AbortSignal | undefined;
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => {
      receivedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    clientFactory.mockReturnValue({
      event: { subscribe },
      session: { children: noChildren() },
      postSessionIdPermissionsPermissionId: vi.fn(),
    });
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      permissionScopesEnabled: true,
      close: () => {},
    });
    registerPermissionSession("scope-server", "/workspace", "session-1");
    await Promise.resolve();
    unregisterPermissionSession("scope-server", "/workspace", "session-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("does not start responders for unscoped test or legacy server entries", () => {
    registerServer({ serverId: "scope-server", baseUrl: "http://127.0.0.1:4096", close: () => {} });
    registerPermissionSession("scope-server", "/workspace", "session-1");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("does not start responders when permission scopes are disabled", () => {
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      permissionScopesEnabled: false,
      close: () => {},
    });
    registerPermissionSession("scope-server", "/workspace", "session-1");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("reports missing servers, stops only exact server scopes, and reports stream failures", async () => {
    expect(() => registerPermissionSession("missing", "/workspace", "session")).toThrow(
      "OpenCode server is not registered: missing",
    );
    unregisterPermissionSession("scope-server", "/missing", "session");
    stopPermissionScope("scope-server", "/missing");

    const signals = new Map<string, AbortSignal>();
    clientFactory.mockImplementation(({ directory }: { directory: string }) => ({
      event: {
        subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => {
          signals.set(directory, signal);
          return directory === "/error"
            ? Promise.reject(new Error("event stream failed"))
            : new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
        }),
      },
      session: { children: noChildren() },
      postSessionIdPermissionsPermissionId: vi.fn(),
    }));
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://localhost",
      permissionScopesEnabled: true,
      close: () => {},
    });
    registerServer({
      serverId: "scope-server-extra",
      baseUrl: "http://localhost",
      permissionScopesEnabled: true,
      close: () => {},
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    registerPermissionSession("scope-server", "/owned", "owned-session");
    registerPermissionSession("scope-server", "/stop-one", "stop-session");
    registerPermissionSession("scope-server-extra", "/error", "error-session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toHaveBeenCalledWith("OpenCode permission responder error:", expect.any(Error));
    stopPermissionScope("scope-server", "/stop-one");
    expect(signals.get("/stop-one")?.aborted).toBe(true);
    stopPermissionScopesForServer("scope-server");
    expect(signals.get("/owned")?.aborted).toBe(true);
    expect(signals.get("/error")?.aborted).toBe(false);
    unregisterPermissionSession("scope-server-extra", "/error", "error-session");
    log.mockRestore();
  });
});

describe("subagent child session acceptance", () => {
  it("admits child sessions discovered by the poller", async () => {
    vi.useFakeTimers();
    const replies: unknown[] = [];
    const stream = controllableStream();
    const children = vi.fn(async ({ path }: { path: { id: string } }) =>
      path.id === "parent-1" ? { data: [{ id: "child-1" }] } : { data: [] },
    );
    clientFactory.mockReturnValue({
      event: { subscribe: vi.fn(async () => ({ stream: stream.stream })) },
      session: { children },
      postSessionIdPermissionsPermissionId: vi.fn(async (request) => {
        replies.push(request);
        return {};
      }),
    });
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/repo",
      permissionPolicy: "allow",
      permissionScopesEnabled: true,
      close: () => {},
    });

    registerPermissionSession("scope-server", "/worktree/one", "parent-1");
    await vi.advanceTimersByTimeAsync(CHILD_POLL_MS);
    expect(children).toHaveBeenCalledWith({ path: { id: "parent-1" } });

    stream.push({
      type: "permission.asked",
      properties: { id: "child-ask", sessionID: "child-1", permission: "bash" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(replies).toEqual([
      { path: { id: "child-1", permissionID: "child-ask" }, body: { response: "always" } },
    ]);
  });

  it("logs one failure per call and keeps polling after thrown or non-ok lookups", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const replies: unknown[] = [];
    const stream = controllableStream();
    const children = vi.fn(async ({ path }: { path: { id: string } }) => {
      if (path.id === "parent-throw") throw new Error("children failed");
      if (path.id === "parent-error") return { error: new Error("HTTP 500") };
      if (path.id === "parent-empty") return {};
      return { data: [{ id: "child-ok" }] };
    });
    clientFactory.mockReturnValue({
      event: { subscribe: vi.fn(async () => ({ stream: stream.stream })) },
      session: { children },
      postSessionIdPermissionsPermissionId: vi.fn(async (request) => {
        replies.push(request);
        return {};
      }),
    });
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/repo",
      permissionPolicy: "allow",
      permissionScopesEnabled: true,
      close: () => {},
    });

    registerPermissionSession("scope-server", "/worktree/one", "parent-throw");
    registerPermissionSession("scope-server", "/worktree/one", "parent-error");
    registerPermissionSession("scope-server", "/worktree/one", "parent-empty");
    registerPermissionSession("scope-server", "/worktree/one", "parent-ok");

    await vi.advanceTimersByTimeAsync(CHILD_POLL_MS);
    expect(
      log.mock.calls.filter(([message]) => message === "OpenCode child session poll error:"),
    ).toHaveLength(2);

    stream.push({
      type: "permission.asked",
      properties: { id: "child-ask", sessionID: "child-ok", permission: "bash" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toEqual([
      { path: { id: "child-ok", permissionID: "child-ask" }, body: { response: "always" } },
    ]);

    const callsAfterFirstPoll = children.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHILD_POLL_MS);
    expect(children.mock.calls.length).toBeGreaterThan(callsAfterFirstPoll);

    log.mockRestore();
  });

  it("stops polling when the last session is unregistered", async () => {
    vi.useFakeTimers();
    const children = vi.fn(async ({ path }: { path: { id: string } }) =>
      path.id === "parent-1" ? { data: [{ id: "child-1" }] } : { data: [] },
    );
    clientFactory.mockReturnValue({
      event: { subscribe: vi.fn(() => new Promise<never>(() => {})) },
      session: { children },
      postSessionIdPermissionsPermissionId: vi.fn(),
    });
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      permissionScopesEnabled: true,
      close: () => {},
    });

    registerPermissionSession("scope-server", "/workspace", "parent-1");
    await vi.advanceTimersByTimeAsync(CHILD_POLL_MS);
    expect(children).toHaveBeenCalledTimes(1);

    unregisterPermissionSession("scope-server", "/workspace", "parent-1");
    await vi.advanceTimersByTimeAsync(CHILD_POLL_MS * 3);
    expect(children).toHaveBeenCalledTimes(1);
  });
});

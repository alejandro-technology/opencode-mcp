import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }));
vi.mock("@opencode/client", () => ({
  OpenCode: { make: (...args: unknown[]) => clientFactory(...args) },
}));

const {
  registerPermissionSession,
  stopPermissionScope,
  stopPermissionScopesForServer,
  unregisterPermissionSession,
} = await import("../../../src/modules/shared/permission-scopes.js");
const { registerServer, removeServer } = await import(
  "../../../src/modules/shared/server-registry.js"
);

afterEach(() => {
  stopPermissionScopesForServer("scope-server");
  stopPermissionScopesForServer("other-server");
  removeServer("scope-server");
  removeServer("scope-server-extra");
  clientFactory.mockReset();
});

describe("directory-scoped permission responders", () => {
  it("uses one directory-bound responder per scope and answers only its owned sessions", async () => {
    const replies: unknown[] = [];
    const subscribe = vi.fn(() =>
      (async function* () {
        yield {
          type: "permission.asked",
          data: { id: "foreign", sessionID: "other", action: "bash" },
        };
        yield {
          type: "permission.asked",
          data: { id: "mine", sessionID: "owned-1", action: "bash" },
        };
        yield {
          type: "permission.asked",
          data: { id: "also-mine", sessionID: "owned-2", action: "bash" },
        };
      })(),
    );
    clientFactory.mockReturnValue({
      event: { subscribe },
      permission: {
        list: vi.fn().mockResolvedValue([]),
        reply: vi.fn(async (request) => {
          replies.push(request);
        }),
      },
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
      { baseUrl: "http://127.0.0.1:4096", fetch: expect.any(Function) },
      { baseUrl: "http://127.0.0.1:4096", fetch: expect.any(Function) },
    ]);
    expect(replies).toEqual([
      { sessionID: "owned-1", requestID: "mine", decision: "always" },
      { sessionID: "owned-2", requestID: "also-mine", decision: "always" },
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
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      };
    });
    clientFactory.mockReturnValue({
      event: { subscribe },
      permission: { list: vi.fn().mockResolvedValue([]), reply: vi.fn() },
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

  it("fails registration when an enabled server cannot produce a client", () => {
    clientFactory.mockReturnValue(undefined);
    registerServer({
      serverId: "scope-server",
      baseUrl: "http://127.0.0.1:4096",
      permissionScopesEnabled: true,
      close: () => {},
    });
    expect(() => registerPermissionSession("scope-server", "/workspace", "session-1")).toThrow(
      "OpenCode client unavailable for server: scope-server",
    );
  });

  it("does not start responders for unscoped test or legacy server entries", () => {
    registerServer({ serverId: "scope-server", baseUrl: "http://127.0.0.1:4096", close: () => {} });
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
    const directories = ["/owned", "/stop-one", "/error"];
    let directoryIndex = 0;
    clientFactory.mockImplementation(() => {
      const directory = directories[directoryIndex++];
      return {
        event: {
          subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => {
            signals.set(directory, signal);
            return {
              async *[Symbol.asyncIterator]() {
                if (directory === "/error") throw new Error("event stream failed");
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), { once: true }),
                );
              },
            };
          }),
        },
        permission: { list: vi.fn().mockResolvedValue([]), reply: vi.fn() },
      };
    });
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
    expect(signals.get("/error")?.aborted).toBe(true);
    unregisterPermissionSession("scope-server-extra", "/error", "error-session");
    log.mockRestore();
  });
});

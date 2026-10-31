import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTERNAL_DIRECTORY_POLICY,
  decidePermission,
  EXTERNAL_DIRECTORY,
  externalDirectoryPermission,
  getExternalDirectoryPolicy,
  type PermissionAsk,
  permissionCallID,
  permissionKind,
  startPermissionResponder,
} from "../../../src/modules/shared/permissions.js";

const noSleep = async () => {};

function ask(overrides: Partial<PermissionAsk> = {}): PermissionAsk {
  return {
    id: "permission-1",
    sessionID: "session-1",
    action: EXTERNAL_DIRECTORY,
    resources: ["/private/*"],
    source: { type: "tool", messageID: "message-1", id: "tool-1" },
    ...overrides,
  };
}

function permissionClient({
  name = "read",
  message = { type: "assistant", content: [{ type: "tool", id: "tool-1", name: "read" }] },
  pending = [],
  streams = [],
  reply = vi.fn().mockResolvedValue(undefined),
}: {
  name?: string | undefined;
  message?: unknown;
  pending?: unknown[];
  streams?: Array<AsyncIterable<unknown> | Error>;
  reply?: ReturnType<typeof vi.fn>;
} = {}) {
  let streamIndex = 0;
  const client = {
    session: {
      message: { get: vi.fn().mockResolvedValue(message) },
    },
    permission: {
      list: vi.fn().mockResolvedValue(pending),
      reply,
    },
    event: {
      subscribe: vi.fn(() => {
        const stream = streams[streamIndex++];
        if (stream instanceof Error) {
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => Promise.reject(stream) };
            },
          };
        }
        return stream ?? { async *[Symbol.asyncIterator]() {} };
      }),
    },
  };
  if (name && message && typeof message === "object" && "content" in message) {
    const content = (message as { content: Array<Record<string, unknown>> }).content;
    if (content[0]?.type === "tool") content[0].name = name;
  }
  return client;
}

async function* streamOf(...events: unknown[]) {
  for (const event of events) yield event;
}

describe("permission request fields", () => {
  it("uses CLI2 action and correlates the originating tool source", () => {
    expect(permissionKind(ask())).toBe(EXTERNAL_DIRECTORY);
    expect(permissionKind({ id: "p", sessionID: "s", action: "bash", resources: [] })).toBe("bash");
    expect(permissionCallID(ask())).toBe("tool-1");
    expect(
      permissionCallID({ id: "p", sessionID: "s", action: "read", resources: [] }),
    ).toBeUndefined();
  });
});

describe("external directory policy", () => {
  const originalEnv = process.env.OPENCODE_MCP_EXTERNAL_DIR;
  const originalArgv = process.argv;
  beforeEach(() => {
    process.argv = ["node", "server.js"];
    delete process.env.OPENCODE_MCP_EXTERNAL_DIR;
  });
  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.OPENCODE_MCP_EXTERNAL_DIR;
    else process.env.OPENCODE_MCP_EXTERNAL_DIR = originalEnv;
  });

  it("defaults to read-only and maps only the external_directory action", () => {
    expect(getExternalDirectoryPolicy()).toBe(DEFAULT_EXTERNAL_DIRECTORY_POLICY);
    expect(externalDirectoryPermission("read-only")).toEqual({
      action: "external_directory",
      resource: "*",
      effect: "ask",
    });
    expect(externalDirectoryPermission("allow").effect).toBe("allow");
    expect(externalDirectoryPermission("deny").effect).toBe("deny");
  });

  it("reads environment policy before CLI policy and ignores invalid inputs", () => {
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=deny"];
    expect(getExternalDirectoryPolicy()).toBe("deny");
    process.env.OPENCODE_MCP_EXTERNAL_DIR = " ALLOW ";
    expect(getExternalDirectoryPolicy()).toBe("allow");
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "invalid";
    expect(getExternalDirectoryPolicy()).toBe("deny");
    delete process.env.OPENCODE_MCP_EXTERNAL_DIR;
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=invalid"];
    expect(getExternalDirectoryPolicy()).toBe("read-only");
  });
});

describe("decidePermission", () => {
  it("approves non-external requests and explicit allow policy once", async () => {
    const client = permissionClient();
    await expect(
      decidePermission(client as never, ask({ action: "bash" }), "read-only", noSleep),
    ).resolves.toEqual({ response: "always", reason: "inside the server working directory" });
    await expect(decidePermission(client as never, ask(), "allow", noSleep)).resolves.toEqual({
      response: "once",
      reason: "external_directory policy is 'allow'",
    });
    expect(client.session.message.get).not.toHaveBeenCalled();
  });

  it("rejects external requests for deny policy without resolving a tool", async () => {
    const client = permissionClient();
    await expect(decidePermission(client as never, ask(), "deny", noSleep)).resolves.toMatchObject({
      response: "reject",
    });
    expect(client.session.message.get).not.toHaveBeenCalled();
  });

  it("approves correlated external read tools once and rejects writes", async () => {
    const readClient = permissionClient();
    await expect(
      decidePermission(readClient as never, ask(), "read-only", noSleep),
    ).resolves.toEqual({ response: "once", reason: "'read' only reads" });
    expect(readClient.session.message.get).toHaveBeenCalledWith(
      { sessionID: "session-1", messageID: "message-1" },
      { signal: undefined },
    );

    const writeClient = permissionClient({ name: "write" });
    await expect(
      decidePermission(writeClient as never, ask(), "read-only", noSleep),
    ).resolves.toEqual({
      response: "reject",
      reason: "'write' writes outside the working directory",
    });
  });

  it("fails closed for unknown source, missing messages, non-assistant and unrecognized tool parts", async () => {
    const noSource = permissionClient();
    await expect(
      decidePermission(noSource as never, ask({ source: undefined }), "read-only", noSleep),
    ).resolves.toMatchObject({ response: "reject" });
    const missing = permissionClient({ message: { type: "user" } });
    await expect(
      decidePermission(missing as never, ask(), "read-only", noSleep),
    ).resolves.toMatchObject({
      response: "reject",
    });
    const notTool = permissionClient({ message: { type: "assistant", content: [] } });
    await expect(
      decidePermission(notTool as never, ask(), "read-only", noSleep),
    ).resolves.toMatchObject({
      response: "reject",
    });
  });
});

describe("startPermissionResponder", () => {
  it("reconciles pending owned asks and filters unrelated stream events", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const pending = ask({ id: "pending" });
    const client = permissionClient({
      pending: [pending],
      reply,
      streams: [
        streamOf(
          { type: "server.connected", data: {} },
          { type: "permission.asked", data: ask({ id: "foreign", sessionID: "foreign" }) },
          { type: "permission.asked", data: ask({ id: "streamed" }) },
          { type: "session.created", data: {} },
        ),
      ],
    });
    const decisions: unknown[] = [];
    let responder: ReturnType<typeof startPermissionResponder>;
    responder = startPermissionResponder(client as never, {
      policy: "allow",
      allowedSessionIDs: () => new Set(["session-1"]),
      onDecision: (_ask, decision) => {
        decisions.push(decision);
        if (decisions.length === 2) responder.stop();
      },
    });
    await responder.done;
    const signal = expect.any(AbortSignal);
    expect(client.event.subscribe).toHaveBeenCalledWith({ signal });
    expect(client.permission.list).toHaveBeenCalledWith({ sessionID: "session-1" }, { signal });
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith(
      { sessionID: "session-1", requestID: "pending", decision: "once" },
      { signal },
    );
    expect(decisions).toHaveLength(2);
  });

  it("reconciles asks that arrived before registration when the stream becomes ready", async () => {
    let subscribed!: () => void;
    let emit!: (event: unknown) => void;
    const ready = new Promise<void>((resolve) => (subscribed = resolve));
    const pending = ask({ id: "raced-before-connect" });
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield await new Promise<unknown>((resolve) => {
          emit = resolve;
          subscribed();
        });
      },
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const client = permissionClient({ pending: [pending], streams: [stream], reply });
    const owned = new Set<string>();
    let responder: ReturnType<typeof startPermissionResponder>;
    responder = startPermissionResponder(client as never, {
      policy: "allow",
      allowedSessionIDs: () => owned,
      onDecision: () => responder.stop(),
    });
    await ready;
    owned.add("session-1");
    emit({ type: "server.connected", data: {} });
    await responder.done;
    expect(client.permission.list).toHaveBeenCalledWith(
      { sessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(reply).toHaveBeenCalledWith(
      { sessionID: "session-1", requestID: "raced-before-connect", decision: "once" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("uses default policy and callbacks when no scoped options are supplied", async () => {
    let responder: ReturnType<typeof startPermissionResponder>;
    const reply = vi.fn(async () => queueMicrotask(() => responder.stop()));
    const client = permissionClient({
      reply,
      streams: [streamOf({ type: "permission.asked", data: ask({ action: "bash" }) })],
    });
    responder = startPermissionResponder(client as never);
    await responder.done;
    expect(reply).toHaveBeenCalledWith(
      { sessionID: "session-1", requestID: "permission-1", decision: "always" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reconnects on stream errors and reports them without leaking to callers", async () => {
    const error = new Error("stream failed");
    const client = permissionClient({ streams: [error] });
    let responder: PermissionResponder;
    const onError = vi.fn(() => responder.stop());
    responder = startPermissionResponder(client as never, {
      allowedSessionIDs: () => new Set(),
      onError,
      sleep: async () => {},
    });
    await responder.done;
    expect(onError).toHaveBeenCalledWith(error);

    await expect(responder.done).resolves.toBeUndefined();
  });

  it("retries an ask after the permission reply fails", async () => {
    let responder: ReturnType<typeof startPermissionResponder>;
    const error = new Error("permission reply failed");
    const client = permissionClient({
      reply: vi.fn().mockRejectedValue(error),
      streams: [streamOf({ type: "permission.asked", data: ask() })],
    });
    const onError = vi.fn(() => responder.stop());
    responder = startPermissionResponder(client as never, {
      policy: "allow",
      allowedSessionIDs: () => new Set(["session-1"]),
      onError,
    });
    await responder.done;
    expect(onError).toHaveBeenCalledWith(error);
    expect(client.permission.reply).toHaveBeenCalledOnce();
  });

  it("ignores duplicate permission request ids on one event stream", async () => {
    const pending = ask({ id: "duplicate" });
    const client = permissionClient({
      streams: [
        streamOf(
          { type: "permission.asked", data: pending },
          { type: "permission.asked", data: pending },
        ),
      ],
    });
    const decisions: unknown[] = [];
    let responder: ReturnType<typeof startPermissionResponder>;
    responder = startPermissionResponder(client as never, {
      policy: "allow",
      allowedSessionIDs: () => new Set(["session-1"]),
      onDecision: (_ask, decision) => decisions.push(decision),
      sleep: async () => responder.stop(),
    });
    await responder.done;
    expect(client.permission.reply).toHaveBeenCalledTimes(1);
    expect(decisions).toHaveLength(1);
  });

  it("tolerates pending-list races, empty ownership, iterator failures, and stopped reconnects", async () => {
    let responder: ReturnType<typeof startPermissionResponder>;
    const pending = ask();
    const client = permissionClient({
      pending: [pending],
      streams: [streamOf({ type: "server.connected" })],
    });
    client.permission.list.mockImplementation(async () => {
      responder.stop();
      return [pending];
    });
    responder = startPermissionResponder(client as never, {
      policy: "allow",
      allowedSessionIDs: () => new Set(["session-1"]),
      sleep: async () => {},
    });
    await responder.done;
    expect(client.permission.list).toHaveBeenCalledOnce();
    expect(client.permission.reply).not.toHaveBeenCalled();

    const noScopes = permissionClient({ streams: [streamOf({ type: "server.connected" })] });
    let emptyResponder: ReturnType<typeof startPermissionResponder>;
    emptyResponder = startPermissionResponder(noScopes as never, {
      sleep: async () => emptyResponder.stop(),
    });
    await emptyResponder.done;
    expect(noScopes.permission.list).not.toHaveBeenCalled();

    let rejectedResponder: ReturnType<typeof startPermissionResponder>;
    const rejectedSleep = vi.fn(() => {
      rejectedResponder.stop();
      return Promise.reject(new Error("delay failed"));
    });
    rejectedResponder = startPermissionResponder(
      permissionClient({ streams: [streamOf()] }) as never,
      {
        sleep: rejectedSleep,
      },
    );
    await rejectedResponder.done;
    expect(rejectedSleep).toHaveBeenCalledOnce();

    let iteratorResponder: ReturnType<typeof startPermissionResponder>;
    const iterator = {
      next: vi.fn().mockResolvedValue({ done: true }),
      return: vi.fn().mockRejectedValue(new Error("iterator close failed")),
    };
    const brokenIterator = {
      event: { subscribe: vi.fn(() => ({ [Symbol.asyncIterator]: () => iterator })) },
      permission: { list: vi.fn(), reply: vi.fn() },
      session: {},
    };
    iteratorResponder = startPermissionResponder(brokenIterator as never, {
      sleep: async () => iteratorResponder.stop(),
    });
    await iteratorResponder.done;
    expect(iterator.return).toHaveBeenCalledOnce();
  });

  it("ignores unknown events and stops immediately when an aborted stream fails", async () => {
    const unknownClient = permissionClient({ streams: [streamOf({ type: "other" })] });
    let unknownResponder: ReturnType<typeof startPermissionResponder>;
    unknownResponder = startPermissionResponder(unknownClient as never, {
      sleep: async () => unknownResponder.stop(),
    });
    await unknownResponder.done;
    expect(unknownClient.permission.reply).not.toHaveBeenCalled();

    const error = new Error("closed connection");
    const failingClient = permissionClient({ streams: [error] });
    const onError = vi.fn();
    const responder = startPermissionResponder(failingClient as never, { onError });
    responder.stop();
    await responder.done;
    expect(onError).not.toHaveBeenCalled();
  });

  it("uses default reconnect delay and error callback", async () => {
    vi.useFakeTimers();
    const error = new Error("transient event stream failure");
    const client = permissionClient({ streams: [error, streamOf()] });
    const responder = startPermissionResponder(client as never);
    await vi.waitFor(() => expect(client.event.subscribe).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(client.event.subscribe).toHaveBeenCalledTimes(2));
    responder.stop();
    await responder.done;
  });

  it("stops reconnecting when the consumer aborts after an ended stream", async () => {
    const client = permissionClient({ streams: [streamOf()] });
    let responder: ReturnType<typeof startPermissionResponder>;
    responder = startPermissionResponder(client as never, {
      allowedSessionIDs: () => new Set(),
      sleep: async () => responder.stop(),
    });
    await expect(responder.done).resolves.toBeUndefined();
  });
});

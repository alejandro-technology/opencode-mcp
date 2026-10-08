import type { OpencodeClient } from "@opencode-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServerConfig,
  DEFAULT_EXTERNAL_DIRECTORY_POLICY,
  decidePermission,
  type ExternalDirectoryPolicy,
  getExternalDirectoryPolicy,
  type PermissionAsk,
  type PermissionResponder,
  permissionCallID,
  permissionKind,
  startPermissionResponder,
} from "../../../src/modules/shared/permissions.js";

/**
 * Mirrors the payload the live server emits (opencode 1.18.18): `permission`
 * rather than `type`, and the call id nested under `tool`.
 */
function ask(overrides: Partial<PermissionAsk> = {}): PermissionAsk {
  return {
    id: "per_1",
    sessionID: "ses_1",
    permission: "external_directory",
    patterns: ["/private/tmp/*"],
    always: ["/private/tmp/*"],
    metadata: { filepath: "/private/tmp/brief.md", parentDir: "/private/tmp" },
    tool: { messageID: "msg_1", callID: "read_0" },
    ...overrides,
  };
}

interface FakeClientOptions {
  messages?: unknown;
  subscribe?: (options?: { signal?: AbortSignal }) => Promise<{ stream: AsyncGenerator<unknown> }>;
  reply?: (args: unknown) => Promise<unknown>;
}

function fakeClient(options: FakeClientOptions = {}) {
  const replies: unknown[] = [];
  const client = {
    session: {
      messages: vi.fn(async () => ({ data: options.messages })),
    },
    event: {
      subscribe: options.subscribe ?? vi.fn(),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async (args: unknown) => {
      replies.push(args);
      return options.reply ? options.reply(args) : { data: {} };
    }),
  };
  return { client: client as unknown as OpencodeClient, raw: client, replies };
}

function toolMessages(callID: string, tool: string) {
  return [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", callID, tool, state: {} }] },
  ];
}

async function* streamOf(...events: unknown[]) {
  for (const event of events) yield event;
}

const noSleep = async () => {};

describe("permission field compatibility", () => {
  it("reads the kind from the live `permission` field", () => {
    expect(permissionKind(ask())).toBe("external_directory");
  });

  it("falls back to the generated-SDK `type` field", () => {
    expect(permissionKind({ id: "p", sessionID: "s", type: "bash" })).toBe("bash");
  });

  it("returns undefined when neither field is present", () => {
    expect(permissionKind({ id: "p", sessionID: "s" })).toBeUndefined();
  });

  it("reads the call id from the live nested `tool` field", () => {
    expect(permissionCallID(ask())).toBe("read_0");
  });

  it("falls back to a top-level call id", () => {
    expect(permissionCallID({ id: "p", sessionID: "s", callID: "legacy_1" })).toBe("legacy_1");
  });

  it("returns undefined when no call id is present", () => {
    expect(permissionCallID({ id: "p", sessionID: "s" })).toBeUndefined();
  });
});

describe("getExternalDirectoryPolicy", () => {
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

  it("defaults to read-only", () => {
    expect(getExternalDirectoryPolicy()).toBe("read-only");
    expect(DEFAULT_EXTERNAL_DIRECTORY_POLICY).toBe("read-only");
  });

  it("reads the env var, case-insensitively and trimmed", () => {
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "  ALLOW ";
    expect(getExternalDirectoryPolicy()).toBe("allow");
  });

  it("falls back to the default for an unrecognised env value", () => {
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "yolo";
    expect(getExternalDirectoryPolicy()).toBe("read-only");
  });

  it("reads a CLI arg when the env var is absent", () => {
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=deny"];
    expect(getExternalDirectoryPolicy()).toBe("deny");
  });

  it("falls back to the default for an unrecognised CLI value", () => {
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=nope"];
    expect(getExternalDirectoryPolicy()).toBe("read-only");
  });

  it("prefers the env var over the CLI arg", () => {
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "deny";
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=allow"];
    expect(getExternalDirectoryPolicy()).toBe("deny");
  });
});

describe("buildServerConfig", () => {
  it("keeps external_directory on ask so the responder can apply the read/write split", () => {
    expect(buildServerConfig("read-only")).toEqual({
      permission: { external_directory: "ask" },
    });
  });

  it("maps allow and deny straight through to the config", () => {
    expect(buildServerConfig("allow")).toEqual({ permission: { external_directory: "allow" } });
    expect(buildServerConfig("deny")).toEqual({ permission: { external_directory: "deny" } });
  });

  it("touches only external_directory so user deny globs survive the merge", () => {
    const config = buildServerConfig("read-only");
    expect(Object.keys(config.permission ?? {})).toEqual(["external_directory"]);
  });
});

describe("decidePermission", () => {
  it("approves anything that is not external_directory with always", async () => {
    const { client } = fakeClient();
    const decision = await decidePermission(
      client,
      ask({ permission: "bash", metadata: { command: "git commit -m x" } }),
      "read-only",
      noSleep,
    );
    expect(decision).toEqual({
      response: "always",
      reason: "inside the server working directory",
    });
  });

  it("recognises a non-external permission sent under the legacy `type` field", async () => {
    const { client } = fakeClient();
    const decision = await decidePermission(
      client,
      { id: "p", sessionID: "s", type: "bash" },
      "read-only",
      noSleep,
    );
    expect(decision.response).toBe("always");
  });

  it("approves external access with always under the allow policy", async () => {
    const { client } = fakeClient();
    const decision = await decidePermission(client, ask(), "allow", noSleep);
    expect(decision.response).toBe("always");
  });

  it("rejects external access under the deny policy", async () => {
    const { client } = fakeClient();
    const decision = await decidePermission(client, ask(), "deny", noSleep);
    expect(decision.response).toBe("reject");
  });

  it("rejects an external shell command without correlating a tool", async () => {
    const { client, raw } = fakeClient();
    const decision = await decidePermission(
      client,
      ask({ metadata: { command: "rm -rf /tmp/x", directories: ["/tmp"] } }),
      "read-only",
      noSleep,
    );
    expect(decision).toEqual({
      response: "reject",
      reason: "shell command outside the working directory",
    });
    expect(raw.session.messages).not.toHaveBeenCalled();
  });

  it("approves an external read with once, not always", async () => {
    const { client, raw } = fakeClient();
    const decision = await decidePermission(client, ask(), "read-only", noSleep);
    expect(decision).toEqual({ response: "once", reason: "'read' only reads" });
    // The call id encodes the tool, so no message round-trip is needed.
    expect(raw.session.messages).not.toHaveBeenCalled();
  });

  it.each([
    "grep_3",
    "glob_1",
    "websearch_0",
    "webfetch_12",
  ])("approves the read-only call id %s", async (callID) => {
    const { client } = fakeClient();
    const decision = await decidePermission(
      client,
      ask({ tool: { callID } }),
      "read-only",
      noSleep,
    );
    expect(decision.response).toBe("once");
  });

  it("rejects an external write", async () => {
    const { client } = fakeClient();
    const decision = await decidePermission(
      client,
      ask({ tool: { callID: "write_0" } }),
      "read-only",
      noSleep,
    );
    expect(decision).toEqual({
      response: "reject",
      reason: "'write' writes outside the working directory",
    });
  });

  it("rejects when the permission carries no call id", async () => {
    const { client, raw } = fakeClient();
    const decision = await decidePermission(client, ask({ tool: undefined }), "read-only", noSleep);
    expect(decision).toEqual({
      response: "reject",
      reason: "could not identify the tool behind the request",
    });
    expect(raw.session.messages).not.toHaveBeenCalled();
  });

  it("falls back to session correlation when the call id does not encode a tool", async () => {
    const { client, raw } = fakeClient({ messages: toolMessages("opaque", "read") });
    const decision = await decidePermission(
      client,
      ask({ tool: { callID: "opaque" } }),
      "read-only",
      noSleep,
    );
    expect(decision.response).toBe("once");
    expect(raw.session.messages).toHaveBeenCalledOnce();
  });

  it("rejects when correlation never matches a tool part", async () => {
    const { client, raw } = fakeClient({ messages: toolMessages("other", "read") });
    const decision = await decidePermission(
      client,
      ask({ tool: { callID: "opaque" } }),
      "read-only",
      noSleep,
    );
    expect(decision.response).toBe("reject");
    expect(raw.session.messages).toHaveBeenCalledTimes(3);
  });

  it("rejects when the session has no messages at all", async () => {
    const { client } = fakeClient({ messages: undefined });
    const decision = await decidePermission(
      client,
      ask({ tool: { callID: "opaque" } }),
      "read-only",
      noSleep,
    );
    expect(decision.response).toBe("reject");
  });

  it("retries correlation, using the real sleep, when the tool part lands late", async () => {
    const messages = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: toolMessages("opaque", "read") });
    const client = { session: { messages } } as unknown as OpencodeClient;

    const decision = await decidePermission(
      client,
      ask({ tool: { callID: "opaque" } }),
      "read-only",
    );

    expect(decision.response).toBe("once");
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("tolerates a request with no metadata", async () => {
    const { client } = fakeClient();
    const decision = await decidePermission(
      client,
      { id: "p", sessionID: "s", permission: "external_directory", tool: { callID: "read_0" } },
      "read-only",
      noSleep,
    );
    expect(decision.response).toBe("once");
  });
});

describe("startPermissionResponder", () => {
  it("answers a permission.asked request and reports the decision", async () => {
    let responder!: PermissionResponder;
    const decisions: unknown[] = [];
    const subscribe = vi.fn(async () => ({
      stream: streamOf({ type: "permission.asked", properties: ask({ permission: "bash" }) }),
    }));
    const { client, replies } = fakeClient({ subscribe });

    responder = startPermissionResponder(client, {
      policy: "read-only",
      sleep: async () => responder.stop(),
      onDecision: (a, d) => decisions.push([a.id, d.response]),
    });
    await responder.done;

    expect(replies).toEqual([
      { path: { id: "ses_1", permissionID: "per_1" }, body: { response: "always" } },
    ]);
    expect(decisions).toEqual([["per_1", "always"]]);
  });

  it("also answers the generated-SDK permission.updated event", async () => {
    let responder!: PermissionResponder;
    const subscribe = vi.fn(async () => ({
      stream: streamOf({ type: "permission.updated", properties: ask({ permission: "bash" }) }),
    }));
    const { client, replies } = fakeClient({ subscribe });

    responder = startPermissionResponder(client, {
      policy: "read-only",
      sleep: async () => responder.stop(),
    });
    await responder.done;

    expect(replies).toHaveLength(1);
  });

  it("ignores events that are not permission requests", async () => {
    let responder!: PermissionResponder;
    const subscribe = vi.fn(async () => ({
      stream: streamOf(
        { type: "session.status", properties: {} },
        { type: "message.part.delta", properties: {} },
      ),
    }));
    const { client, replies } = fakeClient({ subscribe });

    responder = startPermissionResponder(client, {
      policy: "allow",
      sleep: async () => responder.stop(),
    });
    await responder.done;

    expect(replies).toEqual([]);
  });

  it("approves an external read and rejects an external write", async () => {
    let responder!: PermissionResponder;
    const subscribe = vi.fn(async () => ({
      stream: streamOf(
        { type: "permission.asked", properties: ask({ id: "p-read" }) },
        {
          type: "permission.asked",
          properties: ask({ id: "p-write", tool: { callID: "write_0" } }),
        },
      ),
    }));
    const { client, replies } = fakeClient({ subscribe });

    responder = startPermissionResponder(client, {
      policy: "read-only",
      sleep: async () => responder.stop(),
    });
    await responder.done;

    expect(replies).toEqual([
      { path: { id: "ses_1", permissionID: "p-read" }, body: { response: "once" } },
      { path: { id: "ses_1", permissionID: "p-write" }, body: { response: "reject" } },
    ]);
  });

  it("stops mid-stream without answering the remaining requests", async () => {
    let responder!: PermissionResponder;
    const subscribe = vi.fn(async () => ({
      stream: streamOf(
        { type: "permission.asked", properties: ask({ id: "p-1", permission: "bash" }) },
        { type: "permission.asked", properties: ask({ id: "p-2", permission: "bash" }) },
      ),
    }));
    const { client, replies } = fakeClient({ subscribe });

    responder = startPermissionResponder(client, {
      policy: "allow",
      sleep: noSleep,
      onDecision: () => responder.stop(),
    });
    await responder.done;

    expect(replies).toHaveLength(1);
  });

  it("exits after the stream drains when stopped, without waiting to reconnect", async () => {
    let responder!: PermissionResponder;
    const subscribe = vi.fn(async () => ({
      stream: streamOf({ type: "permission.asked", properties: ask({ permission: "bash" }) }),
    }));
    const { client, replies } = fakeClient({ subscribe });

    // No `sleep` override: stopping inside the stream must short-circuit the
    // reconnect wait, so the built-in timer is never armed.
    responder = startPermissionResponder(client, {
      policy: "allow",
      onDecision: () => responder.stop(),
    });
    await responder.done;

    expect(replies).toHaveLength(1);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("reports a subscribe failure and re-subscribes until stopped", async () => {
    let responder!: PermissionResponder;
    const errors: unknown[] = [];
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("stream down"))
      .mockImplementation(async () => ({ stream: streamOf() }));
    const { client } = fakeClient({ subscribe });

    let sleeps = 0;
    responder = startPermissionResponder(client, {
      policy: "allow",
      onError: (error) => errors.push(error),
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) responder.stop();
      },
    });
    await responder.done;

    expect((errors[0] as Error).message).toBe("stream down");
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("reports a reply failure without tearing down the MCP server", async () => {
    let responder!: PermissionResponder;
    const errors: unknown[] = [];
    const subscribe = vi.fn(async () => ({
      stream: streamOf({ type: "permission.asked", properties: ask({ permission: "bash" }) }),
    }));
    const { client } = fakeClient({
      subscribe,
      reply: async () => {
        throw new Error("reply failed");
      },
    });

    responder = startPermissionResponder(client, {
      policy: "allow",
      onError: (error) => errors.push(error),
      sleep: async () => responder.stop(),
    });
    await responder.done;

    expect((errors[0] as Error).message).toBe("reply failed");
  });

  it("reports response-level permission reply failures", async () => {
    let responder!: PermissionResponder;
    const errors: unknown[] = [];
    const subscribe = vi.fn(async () => ({
      stream: streamOf({ type: "permission.asked", properties: ask({ permission: "bash" }) }),
    }));
    const { client } = fakeClient({
      subscribe,
      reply: async () => ({ error: { message: "HTTP 500" } }),
    });

    responder = startPermissionResponder(client, {
      policy: "allow",
      onError: (error) => errors.push(error),
      sleep: async () => responder.stop(),
    });
    await responder.done;

    expect(errors).toEqual([{ message: "HTTP 500" }]);
  });

  it("swallows errors and decisions when no callbacks are supplied", async () => {
    let responder!: PermissionResponder;
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("silent"))
      .mockImplementation(async () => ({
        stream: streamOf({
          type: "permission.asked",
          properties: ask({ permission: "bash" }),
        }),
      }));
    const { client, replies } = fakeClient({ subscribe });

    let sleeps = 0;
    responder = startPermissionResponder(client, {
      policy: "allow",
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) responder.stop();
      },
    });
    await responder.done;

    expect(replies).toHaveLength(1);
  });

  it("returns immediately when stopped before the stream yields", async () => {
    const subscribe = vi.fn(async () => ({ stream: streamOf({ type: "permission.asked" }) }));
    const { client, replies } = fakeClient({ subscribe });

    const responder = startPermissionResponder(client, { policy: "allow", sleep: noSleep });
    responder.stop();
    await responder.done;

    expect(replies).toEqual([]);
  });

  it("falls back to the resolved policy when none is passed", async () => {
    const original = process.env.OPENCODE_MCP_EXTERNAL_DIR;
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "deny";
    let responder!: PermissionResponder;
    const subscribe = vi.fn(async () => ({
      stream: streamOf({ type: "permission.asked", properties: ask() }),
    }));
    const { client, replies } = fakeClient({ subscribe });

    responder = startPermissionResponder(client, { sleep: async () => responder.stop() });
    await responder.done;

    expect(replies).toEqual([
      { path: { id: "ses_1", permissionID: "per_1" }, body: { response: "reject" } },
    ]);

    if (original === undefined) delete process.env.OPENCODE_MCP_EXTERNAL_DIR;
    else process.env.OPENCODE_MCP_EXTERNAL_DIR = original;
  });

  it("answers only permission events for dynamically allowed session IDs", async () => {
    let responder!: PermissionResponder;
    let receivedSignal: AbortSignal | undefined;
    const subscribe = vi.fn(async (options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return {
        stream: streamOf(
          { type: "permission.asked", properties: ask({ sessionID: "unowned" }) },
          { type: "permission.asked", properties: ask({ sessionID: "ses_1" }) },
        ),
      };
    });
    const { client, replies } = fakeClient({ subscribe });
    responder = startPermissionResponder(client, {
      policy: "allow",
      allowedSessionIDs: () => new Set(["ses_1"]),
      onDecision: () => responder.stop(),
    });
    await responder.done;
    expect(subscribe).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(receivedSignal?.aborted).toBe(true);
    expect(replies).toEqual([
      { path: { id: "ses_1", permissionID: "per_1" }, body: { response: "always" } },
    ]);
  });

  it("aborts a blocked event subscription immediately when stopped", async () => {
    let receivedSignal: AbortSignal | undefined;
    const subscribe = vi.fn((options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      receivedSignal = signal;
      if (!signal) throw new Error("responder omitted abort signal");
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const { client, replies } = fakeClient({ subscribe });
    const responder = startPermissionResponder(client, { policy: "allow" });
    await Promise.resolve();
    responder.stop();
    await responder.done;
    expect(receivedSignal?.aborted).toBe(true);
    expect(replies).toEqual([]);
  });
});

describe("policy type", () => {
  it("covers every documented policy", () => {
    const policies: ExternalDirectoryPolicy[] = ["read-only", "allow", "deny"];
    expect(policies.map(buildServerConfig)).toHaveLength(3);
  });
});

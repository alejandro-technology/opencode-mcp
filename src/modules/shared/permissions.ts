import type { Config, OpencodeClient } from "@opencode-ai/sdk";

/**
 * A pending permission request, as the OpenCode server actually emits it.
 *
 * The SDK's generated `Permission` type is stale relative to the running
 * binary (verified against opencode 1.18.18 / `@opencode-ai/sdk` 1.17.20):
 * the live event is `permission.asked` rather than `permission.updated`, the
 * permission kind arrives as `permission` rather than `type`, and the call id
 * is nested under `tool`. Both spellings are accepted so this keeps working
 * whichever side moves first.
 */
export interface PermissionAsk {
  id: string;
  sessionID: string;
  /** Live server field. */
  permission?: string;
  /** Generated-SDK field. */
  type?: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  /** Live server nests the originating call here. */
  tool?: { messageID?: string; callID?: string };
  /** Generated-SDK field. */
  callID?: string;
}

/** Event types that carry a pending permission request. */
const PERMISSION_EVENTS: ReadonlySet<string> = new Set(["permission.asked", "permission.updated"]);

/** The permission kind, reading whichever field this server version emits. */
export function permissionKind(ask: PermissionAsk): string | undefined {
  return ask.permission ?? ask.type;
}

/** The originating tool call id, reading whichever field this server emits. */
export function permissionCallID(ask: PermissionAsk): string | undefined {
  return ask.tool?.callID ?? ask.callID;
}

/**
 * How the delegated agent may touch paths outside the directory the server was
 * launched in.
 *
 * - `read-only` (default): reads outside the cwd are approved, writes are rejected.
 * - `allow`: no boundary at all — anything outside the cwd is approved.
 * - `deny`: nothing outside the cwd is reachable.
 */
export type ExternalDirectoryPolicy = "read-only" | "allow" | "deny";

export const DEFAULT_EXTERNAL_DIRECTORY_POLICY: ExternalDirectoryPolicy = "read-only";

/** The permission type OpenCode raises for any path outside the server cwd. */
export const EXTERNAL_DIRECTORY = "external_directory";

/**
 * Tools that only observe. OpenCode raises a single `external_directory`
 * permission for reads and writes alike, so the operation has to be recovered
 * from the tool that triggered it. Names verified against the live catalog
 * (`client.tool.ids()` on opencode 1.18.18) — there is no `list` tool.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "webfetch", "websearch"]);

/** Delay before re-subscribing after the event stream drops. */
const RECONNECT_DELAY_MS = 1_000;

/** Attempts to correlate a permission to its tool call before giving up. */
const CORRELATION_ATTEMPTS = 3;

/** Delay between correlation attempts, covering the event/message write race. */
const CORRELATION_DELAY_MS = 100;

const POLICIES: ReadonlySet<string> = new Set<ExternalDirectoryPolicy>([
  "read-only",
  "allow",
  "deny",
]);

/**
 * Resolve the external-directory policy.
 *
 * Precedence: the `OPENCODE_MCP_EXTERNAL_DIR` environment variable wins over an
 * `OPENCODE_MCP_EXTERNAL_DIR=<policy>` CLI arg, which wins over `read-only`.
 * Unrecognised values fall back to the default.
 *
 * Reads `process.env` / `process.argv` lazily on each call so tests can vary
 * them between invocations without module re-import tricks.
 */
export function getExternalDirectoryPolicy(): ExternalDirectoryPolicy {
  const fromEnv = parsePolicy(process.env.OPENCODE_MCP_EXTERNAL_DIR);
  if (fromEnv !== undefined) return fromEnv;

  const argPrefix = "OPENCODE_MCP_EXTERNAL_DIR=";
  const argEntry = process.argv.find((arg) => arg.startsWith(argPrefix));
  if (argEntry !== undefined) {
    const fromArg = parsePolicy(argEntry.slice(argPrefix.length));
    if (fromArg !== undefined) return fromArg;
  }

  return DEFAULT_EXTERNAL_DIRECTORY_POLICY;
}

function parsePolicy(value: string | undefined): ExternalDirectoryPolicy | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!POLICIES.has(normalized)) return undefined;
  return normalized as ExternalDirectoryPolicy;
}

/**
 * Build the config handed to `createOpencodeServer`.
 *
 * OpenCode deep-merges this over the user's global config per permission key,
 * so only `external_directory` is touched — existing `read` / `edit` / `bash`
 * rules (including deny globs for secrets) survive untouched.
 *
 * `read-only` keeps the key on `ask` on purpose: the permission responder is
 * what applies the read/write split, and it can only do that if OpenCode still
 * raises the request.
 */
export function buildServerConfig(policy: ExternalDirectoryPolicy): Config {
  const external_directory = policy === "read-only" ? "ask" : policy;
  return { permission: { external_directory } };
}

export type PermissionResponse = "once" | "always" | "reject";

export interface PermissionDecision {
  response: PermissionResponse;
  reason: string;
}

/**
 * Call ids arrive as `<tool>_<n>` (e.g. `read_0`, `write_0`), so the tool name
 * is readable straight off the event with no round-trip and no race.
 */
const CALL_ID_TOOL = /^(.+)_\d+$/;

/**
 * Find the tool that raised a permission.
 *
 * The call id encodes the tool name, which is the fast path. If a future
 * server stops encoding it, fall back to matching the id against the session's
 * tool parts — retried, because the event can land before the part is readable.
 */
async function resolveToolName(
  client: OpencodeClient,
  ask: PermissionAsk,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const callID = permissionCallID(ask);
  if (callID === undefined) return undefined;

  const encoded = CALL_ID_TOOL.exec(callID);
  if (encoded) return encoded[1];

  for (let attempt = 0; attempt < CORRELATION_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(CORRELATION_DELAY_MS);
    const res = await client.session.messages({ path: { id: ask.sessionID } });
    for (const message of res.data ?? []) {
      for (const part of message.parts) {
        if (part.type === "tool" && part.callID === callID) return part.tool;
      }
    }
  }
  return undefined;
}

/**
 * Decide how to answer a pending permission request.
 *
 * Anything that is not `external_directory` targets the directory the server
 * was launched in, which the caller already owns — approved with `always` so
 * repeat calls stop round-tripping.
 *
 * External reads are approved with `once` rather than `always` on purpose: an
 * `always` reply persists the approval keyed by directory pattern, not by
 * operation, which would silently let a later write into that same directory
 * through and defeat the read-only boundary.
 */
export async function decidePermission(
  client: OpencodeClient,
  ask: PermissionAsk,
  policy: ExternalDirectoryPolicy,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<PermissionDecision> {
  if (permissionKind(ask) !== EXTERNAL_DIRECTORY) {
    return { response: "always", reason: "inside the server working directory" };
  }
  if (policy === "allow") {
    return { response: "always", reason: "external_directory policy is 'allow'" };
  }
  if (policy === "deny") {
    return { response: "reject", reason: "external_directory policy is 'deny'" };
  }

  // Shell commands carry their own metadata shape and can write through any
  // number of paths, so they never qualify as read-only.
  if (ask.metadata?.command !== undefined) {
    return { response: "reject", reason: "shell command outside the working directory" };
  }

  const tool = await resolveToolName(client, ask, sleep);
  if (tool === undefined) {
    return { response: "reject", reason: "could not identify the tool behind the request" };
  }
  if (!READ_ONLY_TOOLS.has(tool)) {
    return { response: "reject", reason: `'${tool}' writes outside the working directory` };
  }
  return { response: "once", reason: `'${tool}' only reads` };
}

export interface PermissionResponderOptions {
  policy?: ExternalDirectoryPolicy;
  /** Called on stream/reply failures so they never bubble into the MCP server. */
  onError?: (error: unknown) => void;
  /** Called after each answered request; useful for diagnostics and tests. */
  onDecision?: (ask: PermissionAsk, decision: PermissionDecision) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Dynamic allow-list; the root responder must not answer unrelated sessions. */
  allowedSessionIDs?: () => ReadonlySet<string>;
}

export interface PermissionResponder {
  stop: () => void;
  /** Resolves once the responder loop has exited. */
  done: Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Answer permission requests for a headless server.
 *
 * Without this, any request configured as `ask` blocks the agent forever: there
 * is no interactive approver behind an MCP-spawned server, so the session stays
 * genuinely busy and the task never completes or fails.
 */
export function startPermissionResponder(
  client: OpencodeClient,
  options: PermissionResponderOptions = {},
): PermissionResponder {
  const policy = options.policy ?? getExternalDirectoryPolicy();
  const onError = options.onError ?? (() => {});
  const onDecision = options.onDecision ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  const allowedSessionIDs = options.allowedSessionIDs;
  const controller = new AbortController();

  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort(new Error("permission responder stopped"));
  };

  const waitToReconnect = () =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      controller.signal.addEventListener("abort", finish, { once: true });
      void sleep(RECONNECT_DELAY_MS).then(finish, finish);
    });

  const done = (async () => {
    while (!stopped) {
      try {
        const { stream } = await client.event.subscribe({ signal: controller.signal });
        for await (const event of stream) {
          if (stopped) return;
          if (!PERMISSION_EVENTS.has(event.type)) continue;
          const ask = event.properties as unknown as PermissionAsk;
          if (allowedSessionIDs && !allowedSessionIDs().has(ask.sessionID)) continue;
          const decision = await decidePermission(client, ask, policy, sleep);
          const response = await client.postSessionIdPermissionsPermissionId({
            path: { id: ask.sessionID, permissionID: ask.id },
            body: { response: decision.response },
          });
          if (response.error) throw response.error;
          onDecision(ask, decision);
        }
      } catch (error) {
        if (stopped) return;
        onError(error);
      }
      if (stopped) return;
      await waitToReconnect();
    }
  })();

  return { stop, done };
}

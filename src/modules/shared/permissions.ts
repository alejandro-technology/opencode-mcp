import type { OpenCodeClient } from "@opencode/client";

/** CLI2 permission request payload carried by `permission.asked` and permission.list. */
export interface PermissionAsk {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  source?: { type: string; messageID?: string; id?: string };
  metadata?: Record<string, unknown>;
  message?: string;
}

/** The permission action requested by CLI2. */
export function permissionKind(ask: PermissionAsk): string {
  return ask.action;
}

/** The v2 tool-part id, when the request originated from a tool. */
export function permissionCallID(ask: PermissionAsk): string | undefined {
  return ask.source?.id;
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
 * from the v2 request source and assistant message tool part.
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

export type PermissionResponse = "once" | "always" | "reject";

export function externalDirectoryPermission(policy: ExternalDirectoryPolicy) {
  return {
    action: EXTERNAL_DIRECTORY,
    resource: "*",
    effect: policy === "read-only" ? "ask" : policy,
  } as const;
}

export interface PermissionDecision {
  response: PermissionResponse;
  reason: string;
}

/** Correlate the request's source message and tool-part id to its tool name. */

/**
 * Find the tool that raised a permission.
 *
 * The call id encodes the tool name, which is the fast path. If a future
 * server stops encoding it, fall back to matching the id against the session's
 * tool parts — retried, because the event can land before the part is readable.
 */
async function resolveToolName(
  client: OpenCodeClient,
  ask: PermissionAsk,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const toolID = ask.source?.id ?? permissionCallID(ask);
  const messageID = ask.source?.messageID;
  if (toolID === undefined || messageID === undefined || ask.source?.type !== "tool")
    return undefined;
  for (let attempt = 0; attempt < CORRELATION_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(CORRELATION_DELAY_MS);
    const message = await client.session.message.get(
      { sessionID: ask.sessionID, messageID },
      { signal },
    );
    if (message.type !== "assistant") continue;
    const tool = message.content.find((part) => part.type === "tool" && part.id === toolID);
    if (tool?.type === "tool") return tool.name;
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
  client: OpenCodeClient,
  ask: PermissionAsk,
  policy: ExternalDirectoryPolicy,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  signal?: AbortSignal,
): Promise<PermissionDecision> {
  if (permissionKind(ask) !== EXTERNAL_DIRECTORY) {
    return { response: "always", reason: "inside the server working directory" };
  }
  if (policy === "allow") {
    return { response: "once", reason: "external_directory policy is 'allow'" };
  }
  if (policy === "deny") {
    return { response: "reject", reason: "external_directory policy is 'deny'" };
  }

  const tool = await resolveToolName(client, ask, sleep, signal);
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
  client: OpenCodeClient,
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

  const handled = new Set<string>();
  const handlePermission = async (ask: PermissionAsk, signal: AbortSignal) => {
    if (stopped || (allowedSessionIDs && !allowedSessionIDs().has(ask.sessionID))) return;
    if (handled.has(ask.id)) return;
    handled.add(ask.id);
    try {
      const decision = await decidePermission(client, ask, policy, sleep, signal);
      await client.permission.reply(
        {
          sessionID: ask.sessionID,
          requestID: ask.id,
          decision: decision.response,
        },
        { signal },
      );
      onDecision(ask, decision);
    } catch (error) {
      handled.delete(ask.id);
      throw error;
    }
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
        const connection = new AbortController();
        const abortConnection = () => connection.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", abortConnection, { once: true });
        const iterator = client.event
          .subscribe({ signal: connection.signal })
          [Symbol.asyncIterator]();
        let nextEvent = iterator.next();
        try {
          while (!stopped) {
            const next = await nextEvent;
            if (next.done) break;
            const event = next.value;
            if (event.type === "server.connected") {
              const sessions = allowedSessionIDs?.() ?? new Set<string>();
              for (const sessionID of sessions) {
                const requests = await client.permission.list(
                  { sessionID },
                  { signal: connection.signal },
                );
                for (const ask of requests) await handlePermission(ask, connection.signal);
              }
            } else if (event.type === "permission.asked") {
              await handlePermission(event.data, connection.signal);
            }
            nextEvent = iterator.next();
          }
        } finally {
          connection.abort(new Error("permission event connection closed"));
          controller.signal.removeEventListener("abort", abortConnection);
          try {
            await iterator.return?.();
          } catch {
            // The abort signal already stopped the transport.
          }
          await nextEvent.catch(() => undefined);
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

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
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

/** A pending request as the v2 REST surface lists it. */
interface PendingPermissionItem {
  id: string;
  sessionID: string;
  action?: string;
  resources?: string[];
  metadata?: Record<string, unknown>;
  save?: string[];
  source?: { messageID?: string; callID?: string };
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

/** Poll interval for the v2 pending-permission drain loop. */
const PENDING_POLL_MS = 1_000;

/** Upper bound on the remembered-handled permission ids. */
const HANDLED_LIMIT = 512;

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
 * The generated `Config` type only admits a scalar for this key, but the live
 * server also accepts an object of glob rules. Keep the cast scoped here.
 */
type ExternalDirectoryConfig = NonNullable<Config["permission"]>["external_directory"];

/**
 * Build the config handed to `createOpencodeServer`.
 *
 * OpenCode deep-merges this over the user's global config per permission key,
 * so only `external_directory` is touched — existing `read` / `edit` / `bash`
 * rules (including deny globs for secrets) survive untouched.
 *
 * When `options.rootDirectory` is provided under `read-only`, the
 * `external_directory` key becomes a single object rule allowing everything
 * inside that tree. That object replaces any lower-level `external_directory`
 * rules for the key (it does not merge with them); `read` / `edit` / `bash`
 * entries are still untouched. Paths inside the server launch tree then need
 * no permission round-trip at all.
 *
 * `read-only` without a root keeps the key on `ask` on purpose: the permission
 * responder is what applies the read/write split, and it can only do that if
 * OpenCode still raises the request.
 */
export function buildServerConfig(
  policy: ExternalDirectoryPolicy,
  options: { rootDirectory?: string } = {},
): Config {
  if (policy === "read-only") {
    const rootDirectory = options.rootDirectory;
    if (rootDirectory === undefined) {
      return { permission: { external_directory: "ask" } };
    }
    const rules = {
      [`${rootDirectory}/**`]: "allow",
    } as unknown as ExternalDirectoryConfig;
    return { permission: { external_directory: rules } };
  }
  return { permission: { external_directory: policy } };
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

export interface PermissionDecisionOptions {
  sleep?: (ms: number) => Promise<void>;
  rootDirectory?: string;
}

/**
 * True when every external-resource pattern resolves to a path inside
 * `rootDirectory`.
 *
 * `external_directory` asks carry the canonical resource pattern of the
 * directory that was touched (e.g. `/repo/ui/*`), so containment can be decided
 * without correlating a tool call. Non-string entries, relative paths, and an
 * empty pattern list fail closed.
 */
export function groundExternalPatterns(patterns: unknown, rootDirectory: string): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  const root = rootDirectory.replace(/\/+$/, "");

  return patterns.every((entry) => {
    if (typeof entry !== "string") return false;

    let pattern = entry.replace(/\/\*{1,2}$/, "");
    if (pattern.startsWith("~")) pattern = `${homedir()}${pattern.slice(1)}`;
    pattern = pattern.replace(/\\/g, "/").replace(/\/+$/, "");

    if (!isAbsolute(pattern)) return false;
    return pattern === root || `${pattern}/`.startsWith(`${root}/`);
  });
}

/** A shell ask is recognisable from its metadata or its resolved tool name. */
function isShellAsk(ask: PermissionAsk, resolvedToolName: string | undefined): boolean {
  return ask.metadata?.command !== undefined || resolvedToolName === "bash";
}

function shellDecision(ask: PermissionAsk, rootDirectory: string | undefined): PermissionDecision {
  const inside =
    rootDirectory !== undefined &&
    Array.isArray(ask.patterns) &&
    groundExternalPatterns(ask.patterns, rootDirectory);

  return inside
    ? { response: "once", reason: "shell command inside the server working directory" }
    : { response: "reject", reason: "shell command outside the working directory" };
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
  options: PermissionDecisionOptions = {},
): Promise<PermissionDecision> {
  const sleep = options.sleep ?? defaultSleep;
  const rootDirectory = options.rootDirectory;

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
  // number of paths. They are never read-only, but an ask that stays inside the
  // server launch tree can still be approved without a round-trip.
  const hasCommand = ask.metadata?.command !== undefined;
  const tool = hasCommand ? undefined : await resolveToolName(client, ask, sleep);
  if (isShellAsk(ask, tool)) {
    return shellDecision(ask, rootDirectory);
  }

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
  /**
   * Base URL of a v2 server. When set, pending requests are also drained over
   * REST, because v2 servers never surface them on the legacy event stream.
   */
  baseUrl?: string;
  /** Directory scoped for the v2 pending list query. */
  directory?: string;
  /**
   * Server launch root used to ground which external asks count as inside the
   * owned tree. Falls back to `directory` when omitted.
   */
  rootDirectory?: string;
}

export interface PermissionResponder {
  stop: () => void;
  /** Resolves once the responder loop has exited. */
  done: Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pendingItemToAsk(item: PendingPermissionItem): PermissionAsk {
  return {
    id: item.id,
    sessionID: item.sessionID,
    permission: item.action,
    patterns: item.resources,
    metadata: item.metadata,
    always: item.save,
    tool: item.source
      ? { messageID: item.source.messageID, callID: item.source.callID }
      : undefined,
  };
}

/** Remember a handled id, dropping the oldest entries past the FIFO cap. */
function rememberHandled(handled: Set<string>, id: string): void {
  handled.add(id);
  if (handled.size <= HANDLED_LIMIT) return;
  const kept = Array.from(handled).slice(-HANDLED_LIMIT);
  handled.clear();
  for (const entry of kept) handled.add(entry);
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
  const baseUrl = options.baseUrl;
  const directory = options.directory;
  const rootDirectory = options.rootDirectory ?? options.directory;
  const controller = new AbortController();

  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort(new Error("permission responder stopped"));
  };

  const waitFor = (ms: number) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      controller.signal.addEventListener("abort", finish, { once: true });
      void sleep(ms).then(finish, finish);
    });

  const waitToReconnect = () => waitFor(RECONNECT_DELAY_MS);
  const waitForPoll = () => waitFor(PENDING_POLL_MS);

  const sseDone = (async () => {
    while (!stopped) {
      try {
        const { stream } = await client.event.subscribe({ signal: controller.signal });
        for await (const event of stream) {
          if (stopped) return;
          if (!PERMISSION_EVENTS.has(event.type)) continue;
          const ask = event.properties as unknown as PermissionAsk;
          if (allowedSessionIDs && !allowedSessionIDs().has(ask.sessionID)) continue;
          const decision = await decidePermission(client, ask, policy, {
            sleep,
            rootDirectory,
          });
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

  const drainDone = (async () => {
    if (baseUrl === undefined) return;

    const handled = new Set<string>();
    while (!stopped) {
      let failed = false;
      try {
        const query = directory === undefined ? "" : `?directory=${encodeURIComponent(directory)}`;
        const listResponse = await fetch(`${baseUrl}/api/permission/request${query}`, {
          signal: controller.signal,
        });
        if (!listResponse.ok) {
          throw new Error(`permission list failed: HTTP ${listResponse.status}`);
        }
        const body = (await listResponse.json()) as { data?: PendingPermissionItem[] };

        for (const item of body.data ?? []) {
          if (handled.has(item.id)) continue;
          if (allowedSessionIDs && !allowedSessionIDs().has(item.sessionID)) continue;

          rememberHandled(handled, item.id);
          const ask = pendingItemToAsk(item);
          try {
            const decision = await decidePermission(client, ask, policy, {
              sleep,
              rootDirectory,
            });
            const replyResponse = await fetch(
              `${baseUrl}/api/session/${ask.sessionID}/permission/${ask.id}/reply`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reply: decision.response }),
                signal: controller.signal,
              },
            );
            if (!replyResponse.ok) {
              throw new Error(`permission reply failed: HTTP ${replyResponse.status}`);
            }
            onDecision(ask, decision);
          } catch (error) {
            if (stopped) return;
            onError(error);
          }
        }
      } catch (error) {
        if (stopped) return;
        onError(error);
        failed = true;
      }
      if (stopped) return;
      if (failed) await waitToReconnect();
      else await waitForPoll();
    }
  })();

  const done = Promise.all([sseDone, drainDone]).then(() => undefined);

  return { stop, done };
}

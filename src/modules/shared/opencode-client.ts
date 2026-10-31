import { type ModelRef, OpenCode, type OpenCodeClient } from "@opencode/client";
import { buildExecutionUsage, type ExecutionUsageSnapshot } from "./execution-usage.js";
import { getServer } from "./server-registry.js";
import { getTask } from "./task-registry.js";

const SDK_REQUEST_TIMEOUT_MS = 30_000;

function parseToolInput(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function fetchWithDeadline(request: Request): Promise<Response> {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("OpenCode request deadline exceeded")),
    SDK_REQUEST_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const response = await fetch(new Request(request, { signal: controller.signal }));
    if (response.status < 400) return response;
    const body = await response.text();
    let annotatedBody = body;
    try {
      const value: unknown = JSON.parse(body);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        annotatedBody = JSON.stringify({
          ...value,
          response: { status: response.status },
        });
      }
    } catch {
      // The official client will classify a malformed error response itself.
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Response(annotatedBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abortFromRequest);
  }
}

/** Build an HTTP client for a tracked server, or undefined if the id is unknown. */
export function clientForServer(serverId: string, directory?: string): OpenCodeClient | undefined {
  const server = getServer(serverId);
  if (!server) return undefined;
  const password = server.password;
  const headers = password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    : undefined;
  void directory;
  return OpenCode.make({
    baseUrl: server.baseUrl,
    fetch: (input, init) => fetchWithDeadline(new Request(input, init)),
    ...(headers ? { headers } : {}),
  });
}

/** Resolve a task to its server client and session id, or undefined if unknown. */
export function clientForTask(
  taskId: string,
): { client: OpenCodeClient; sessionId: string } | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const client = clientForServer(task.serverId, task.directory);
  if (!client) return undefined;
  return { client, sessionId: task.sessionId };
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  time: { created: number; completed?: number };
  error?: { name: string; message?: string };
  parentID?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: unknown;
}

export type Part =
  | { type: "text"; text: string }
  | {
      type: "tool";
      tool: string;
      callID: string;
      state: {
        status: "pending" | "running" | "completed" | "error";
        input: Record<string, unknown>;
        output?: string;
        error?: string;
      };
    };

export interface AssistantEntry {
  info: AssistantMessage;
  parts: Part[];
}

export interface SessionSelection {
  agent?: string;
  model?: ModelRef;
}

export async function restoreSessionSelection(
  client: OpenCodeClient,
  sessionId: string,
  selection: SessionSelection,
): Promise<void> {
  if (selection.agent)
    await client.session.switchAgent({ sessionID: sessionId, agent: selection.agent });
  if (selection.model)
    await client.session.switchModel({ sessionID: sessionId, model: selection.model });
}

export function isTerminalTaskStatus(status: string): boolean {
  return ["completed", "failed", "empty", "cancelled", "error"].includes(status);
}

export function sdkResponseError(response: unknown): unknown {
  return typeof response === "object" && response !== null && "error" in response
    ? response.error
    : undefined;
}

/** Fetch every assistant message (with its parts) for a session, oldest first. */
export async function assistantEntries(
  client: OpenCodeClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<AssistantEntry[]> {
  const messages = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.message.list(
      { sessionID: sessionId, ...(cursor ? { cursor } : { order: "asc" }) },
      { signal },
    );
    messages.push(...page.data);
    const nextCursor = page.cursor.next ?? undefined;
    if (nextCursor && seenCursors.has(nextCursor))
      throw new Error("OpenCode message pagination returned a repeated cursor");
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  const entries: AssistantEntry[] = [];
  let currentUserMessageID: string | undefined;
  for (const message of messages) {
    if (message.type === "user") {
      currentUserMessageID = message.id;
      continue;
    }
    if (message.type !== "assistant") continue;
    const info = {
      id: message.id,
      role: "assistant" as const,
      time: { created: message.time.created, completed: message.time.completed },
      error: message.error
        ? { name: message.error.type, message: message.error.message }
        : undefined,
      parentID:
        typeof message.metadata?.parentID === "string"
          ? message.metadata.parentID
          : currentUserMessageID,
      providerID: message.model.providerID,
      modelID: message.model.id,
      cost: message.cost,
      tokens: message.tokens,
    } as AssistantMessage;
    const parts = message.content.flatMap((part): Part[] => {
      if (part.type === "text") return [{ type: "text" as const, text: part.text } as Part];
      if (part.type === "reasoning") return [];
      if (part.type === "tool") {
        const state = part.state;
        const input = typeof state.input === "string" ? parseToolInput(state.input) : state.input;
        const mapped = {
          status: state.status === "streaming" ? "pending" : state.status,
          input: input ?? {},
          output:
            state.status === "completed"
              ? state.content.map((c) => (c.type === "text" ? c.text : "")).join("\\n")
              : undefined,
          error: state.status === "error" ? state.error.message : undefined,
        };
        return [
          {
            type: "tool" as const,
            tool: part.name,
            callID: part.id,
            state: mapped,
          } as unknown as Part,
        ];
      }
      return [];
    }) as Part[];
    entries.push({ info, parts });
  }
  return entries;
}

function entriesForCurrentRun(entries: AssistantEntry[], taskId: string): AssistantEntry[] {
  const task = getTask(taskId);
  const run = task?.runs?.find((item) => item.run_id === task.currentRunId);
  if (!run) return entries;
  return entries.filter((entry) => entry.info.parentID === run.message_id);
}

export async function currentRunEntries(
  client: OpenCodeClient,
  sessionId: string,
  taskId: string,
): Promise<AssistantEntry[]> {
  return entriesForCurrentRun(await assistantEntries(client, sessionId), taskId);
}

/** Every part the assistant emitted across the whole session, oldest first. */
export function sessionParts(entries: AssistantEntry[]): Part[] {
  return entries.flatMap((entry) => entry.parts);
}

/** Fetch the most recent assistant message (with its parts) for a session. */
export async function lastAssistantEntry(
  client: OpenCodeClient,
  sessionId: string,
): Promise<AssistantEntry | undefined> {
  return (await assistantEntries(client, sessionId)).at(-1);
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "empty" | "cancelled";

export interface TaskProgress {
  /** Last ~500 chars of concatenated TextPart text from the last assistant message. */
  text_snippet: string;
  /** Count of ToolPart parts whose state.status is "completed". */
  tool_calls_completed: number;
  /** Completed tool calls that can mutate the workspace. */
  mutating_tool_calls: number;
  /** Distinct file paths touched by completed mutating tool calls. */
  files_touched: string[];
  /** Tool name of the last ToolPart whose state.status is "running" or "pending". */
  current_tool?: string;
  /** state.status of that tool part. */
  current_tool_status?: string;
}

export interface TaskStatusResult {
  task_id: string;
  status: TaskStatus;
  error?: string;
  progress?: TaskProgress;
  usage?: ExecutionUsageSnapshot;
}

const TEXT_SNIPPET_MAX_LENGTH = 500;

/**
 * Tools that can change the workspace. Verified against the live tool catalog
 * (`client.tool.ids()` on opencode 1.18.18): the patch tool is `apply_patch`,
 * and there is no `list` tool. `task` delegates to a subagent, which can write
 * through any of the others.
 */
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "bash",
  "task",
  "shell",
  "subagent",
  "patch",
]);

/**
 * Whether an assistant turn actually produced anything.
 *
 * A completed timestamp only says the turn ended, not that it did work: an
 * aborted or rejected turn carries a completed timestamp with no parts at all,
 * which is byte-for-byte indistinguishable from a task that succeeded quietly.
 */
export function hasWork(parts: Part[]): boolean {
  for (const part of parts) {
    if (part.type === "text" && part.text.trim() !== "") return true;
    if (part.type === "tool") return true;
  }
  return false;
}

/**
 * How long an idle session may stay without any assistant message before the
 * task is considered dead (e.g. the fire-and-forget prompt was rejected).
 */
export const PENDING_STALL_MS = 15_000;

/**
 * The workspace path a completed tool call wrote to, if it names one.
 *
 * Verified against a live server: `write` and `edit` carry the path as
 * `state.input.filePath`; `bash` carries only `command`, so it counts as
 * mutating without contributing a path.
 */
function touchedFilePath(input: { [key: string]: unknown }): string | undefined {
  const filePath = input.path ?? input.filePath;
  return typeof filePath === "string" && filePath !== "" ? filePath : undefined;
}

/**
 * Build a TaskProgress summary.
 *
 * `latest` is the current assistant turn — it drives the text snippet and the
 * in-flight tool. `whole` is every assistant part in the session and drives the
 * side-effect evidence, because an agent's edits land in earlier turns while
 * the final turn is usually just "DONE". Reading evidence off the last message
 * alone reports `files_touched: []` for a task that rewrote the workspace.
 */
export function buildProgress(latest: Part[], whole: Part[] = latest): TaskProgress {
  let text = "";
  let currentTool: string | undefined;
  let currentToolStatus: string | undefined;

  for (const part of latest) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    if (
      part.type === "tool" &&
      (part.state.status === "running" || part.state.status === "pending")
    ) {
      currentTool = part.tool;
      currentToolStatus = part.state.status;
    }
  }

  let toolCallsCompleted = 0;
  let mutatingToolCalls = 0;
  const filesTouched = new Set<string>();

  for (const part of whole) {
    if (part.type !== "tool" || part.state.status !== "completed") continue;
    toolCallsCompleted++;
    if (!MUTATING_TOOLS.has(part.tool)) continue;
    mutatingToolCalls++;
    const filePath = touchedFilePath(part.state.input);
    if (filePath !== undefined) filesTouched.add(filePath);
  }

  return {
    text_snippet: text.slice(-TEXT_SNIPPET_MAX_LENGTH),
    tool_calls_completed: toolCallsCompleted,
    mutating_tool_calls: mutatingToolCalls,
    files_touched: [...filesTouched],
    current_tool: currentTool,
    current_tool_status: currentToolStatus,
  };
}

/** Message returned alongside the `cancelled` status, shared by status and result. */
export const CANCELLED_TASK_MESSAGE =
  "the task was cancelled via opencode_cancel_task; any output below is whatever the agent produced before the abort";

/** Message returned alongside the `empty` status, shared by status and result. */
export const EMPTY_TURN_MESSAGE =
  "the session finished without producing any text or tool calls; the prompt was likely rejected or the turn was aborted";

export interface DeriveTaskStatusOptions {
  includeProgress?: boolean;
  includeUsage?: boolean;
  usageMessageID?: string;
  signal?: AbortSignal;
}

function usageSnapshot(
  entries: AssistantEntry[] | null,
  currentMessageID: string | undefined,
  diagnostic?: string,
): ExecutionUsageSnapshot {
  return {
    captured_at: new Date().toISOString(),
    snapshot_kind: "live_observation",
    report: entries ? buildExecutionUsage(entries, currentMessageID) : null,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

async function readObservedEntries(
  client: OpenCodeClient,
  sessionId: string,
  signal: AbortSignal | undefined,
  includeUsage: boolean,
): Promise<{ entries: AssistantEntry[]; diagnostic?: string }> {
  try {
    return { entries: await assistantEntries(client, sessionId, signal) };
  } catch (error) {
    if (!includeUsage) throw error;
    return {
      entries: [],
      diagnostic: `usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function deriveAssistantTurnStatus(
  entry: AssistantEntry | undefined,
): Pick<TaskStatusResult, "status" | "error"> {
  if (!entry) return { status: "pending" };
  if (entry.info.error) return { status: "failed", error: entry.info.error.name };
  if (!entry.info.time.completed) return { status: "running" };
  const failedTool = entry.parts.find(
    (part) => part.type === "tool" && part.state.status === "error",
  );
  if (failedTool?.type === "tool" && failedTool.state.status === "error")
    return { status: "failed", error: `${failedTool.tool} failed: ${failedTool.state.error}` };
  if (!hasWork(entry.parts)) return { status: "empty", error: EMPTY_TURN_MESSAGE };
  return { status: "completed" };
}

/**
 * Derive the current status of a task by inspecting session busy state and
 * the last assistant message. Shared by opencode_get_task_status and
 * opencode_wait_for_task so both use identical status derivation.
 */
export async function deriveTaskStatus(
  client: OpenCodeClient,
  sessionId: string,
  taskId: string,
  options?: DeriveTaskStatusOptions,
): Promise<TaskStatusResult> {
  const includeProgress = options?.includeProgress ?? false;
  const includeUsage = options?.includeUsage ?? false;
  const signal = options?.signal;

  // Cancellation wins over everything else: an aborted session keeps its
  // completed timestamp, so any later check would call it `completed`.
  const task = getTask(taskId);
  const currentRun = task?.runs?.find((item) => item.run_id === task.currentRunId);
  const usageMessageID = options?.usageMessageID ?? currentRun?.message_id;
  if (task?.cancelledAt !== undefined || currentRun?.cancelledAt !== undefined) {
    const observed =
      includeProgress || includeUsage
        ? await readObservedEntries(client, sessionId, signal, includeUsage)
        : { entries: [] as AssistantEntry[] };
    const allEntries = observed.entries;
    const entries = includeProgress ? entriesForCurrentRun(allEntries, taskId) : [];
    const latest = entries.at(-1);
    return {
      task_id: taskId,
      status: "cancelled",
      error: CANCELLED_TASK_MESSAGE,
      progress: latest ? buildProgress(latest.parts, sessionParts(entries)) : undefined,
      ...(includeUsage
        ? {
            usage: usageSnapshot(
              observed.diagnostic ? null : allEntries,
              usageMessageID,
              observed.diagnostic,
            ),
          }
        : {}),
    };
  }

  // The status map only lists sessions that are actively working.
  const sessionStatus = (await client.session.active({ signal }))[sessionId];
  if (sessionStatus?.type === "running") {
    if (includeProgress || includeUsage) {
      const observed = await readObservedEntries(client, sessionId, signal, includeUsage);
      const allEntries = observed.entries;
      const entries = includeProgress ? entriesForCurrentRun(allEntries, taskId) : [];
      const latest = entries.at(-1);
      return {
        task_id: taskId,
        status: "running",
        progress: latest ? buildProgress(latest.parts, sessionParts(entries)) : undefined,
        ...(includeUsage
          ? {
              usage: usageSnapshot(
                observed.diagnostic ? null : allEntries,
                usageMessageID,
                observed.diagnostic,
              ),
            }
          : {}),
      };
    }
    return { task_id: taskId, status: "running" };
  }

  // Not busy: inspect the last assistant message to tell pending from done.
  const allEntries = await assistantEntries(client, sessionId, signal);
  const entries = entriesForCurrentRun(allEntries, taskId);
  const usage = includeUsage ? usageSnapshot(allEntries, usageMessageID) : undefined;
  const entry = entries.at(-1);
  if (!entry) {
    // Idle session with no assistant output: either the prompt was just accepted,
    // or it was silently rejected (fire-and-forget) and will never run. Past the
    // stall window, report failure instead of leaving the task pending forever.
    const task = getTask(taskId);
    if (task?.createdAt !== undefined && Date.now() - task.createdAt > PENDING_STALL_MS) {
      return {
        task_id: taskId,
        status: "failed",
        error:
          "task produced no output after starting; the prompt was likely rejected (e.g. invalid model or agent)",
        ...(usage ? { usage } : {}),
      };
    }
    return { task_id: taskId, status: "pending", ...(usage ? { usage } : {}) };
  }
  const turn = deriveAssistantTurnStatus(entry);
  return {
    task_id: taskId,
    ...turn,
    progress: includeProgress ? buildProgress(entry.parts, sessionParts(entries)) : undefined,
    ...(usage ? { usage } : {}),
  };
}

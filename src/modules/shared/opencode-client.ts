import {
  type AssistantMessage,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk";
import { getServer } from "./server-registry.js";
import { getTask } from "./task-registry.js";

/** Build an HTTP client for a tracked server, or undefined if the id is unknown. */
export function clientForServer(serverId: string): OpencodeClient | undefined {
  const server = getServer(serverId);
  if (!server) return undefined;
  return createOpencodeClient({ baseUrl: server.baseUrl });
}

/** Resolve a task to its server client and session id, or undefined if unknown. */
export function clientForTask(
  taskId: string,
): { client: OpencodeClient; sessionId: string } | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const client = clientForServer(task.serverId);
  if (!client) return undefined;
  return { client, sessionId: task.sessionId };
}

export interface AssistantEntry {
  info: AssistantMessage;
  parts: Part[];
}

/** Fetch the most recent assistant message (with its parts) for a session. */
export async function lastAssistantEntry(
  client: OpencodeClient,
  sessionId: string,
): Promise<AssistantEntry | undefined> {
  const res = await client.session.messages({ path: { id: sessionId } });
  const messages = res.data ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (entry.info.role === "assistant") {
      return { info: entry.info, parts: entry.parts };
    }
  }
  return undefined;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskProgress {
  /** Last ~500 chars of concatenated TextPart text from the last assistant message. */
  text_snippet: string;
  /** Count of ToolPart parts whose state.status is "completed". */
  tool_calls_completed: number;
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
}

const TEXT_SNIPPET_MAX_LENGTH = 500;

/** Build a TaskProgress summary from a message's parts. */
export function buildProgress(parts: Part[]): TaskProgress {
  let text = "";
  let toolCallsCompleted = 0;
  let currentTool: string | undefined;
  let currentToolStatus: string | undefined;

  for (const part of parts) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    if (part.type === "tool") {
      if (part.state.status === "completed") {
        toolCallsCompleted++;
      } else if (part.state.status === "running" || part.state.status === "pending") {
        currentTool = part.tool;
        currentToolStatus = part.state.status;
      }
    }
  }

  return {
    text_snippet: text.slice(-TEXT_SNIPPET_MAX_LENGTH),
    tool_calls_completed: toolCallsCompleted,
    current_tool: currentTool,
    current_tool_status: currentToolStatus,
  };
}

export interface DeriveTaskStatusOptions {
  includeProgress?: boolean;
}

/**
 * Derive the current status of a task by inspecting session busy state and
 * the last assistant message. Shared by opencode_get_task_status and
 * opencode_wait_for_task so both use identical status derivation.
 */
export async function deriveTaskStatus(
  client: OpencodeClient,
  sessionId: string,
  taskId: string,
  options?: DeriveTaskStatusOptions,
): Promise<TaskStatusResult> {
  const includeProgress = options?.includeProgress ?? false;

  // The status map only lists sessions that are actively working.
  const statusRes = await client.session.status();
  const sessionStatus = statusRes.data?.[sessionId];
  if (sessionStatus?.type === "busy" || sessionStatus?.type === "retry") {
    if (includeProgress) {
      const entry = await lastAssistantEntry(client, sessionId);
      return {
        task_id: taskId,
        status: "running",
        progress: entry ? buildProgress(entry.parts) : undefined,
      };
    }
    return { task_id: taskId, status: "running" };
  }

  // Not busy: inspect the last assistant message to tell pending from done.
  const entry = await lastAssistantEntry(client, sessionId);
  if (!entry) {
    return { task_id: taskId, status: "pending" };
  }
  if (entry.info.error) {
    return { task_id: taskId, status: "failed", error: entry.info.error.name };
  }
  if (entry.info.time.completed) {
    return { task_id: taskId, status: "completed" };
  }
  return {
    task_id: taskId,
    status: "running",
    progress: includeProgress ? buildProgress(entry.parts) : undefined,
  };
}

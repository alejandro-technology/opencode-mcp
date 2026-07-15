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

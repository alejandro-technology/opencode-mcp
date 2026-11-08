import { createOpencodeClient } from "@opencode-ai/sdk";
import { fetchWithDeadline, sdkResponseError } from "./opencode-client.js";
import { type ExternalDirectoryPolicy, startPermissionResponder } from "./permissions.js";
import { getServer } from "./server-registry.js";

/**
 * How often a scope looks for subagent (child) sessions.
 *
 * A delegated task's subagents run as child sessions of the registered parent
 * and their permission asks carry the child's session id, so a responder that
 * only knows the registered ids would skip them and wedge the task.
 */
export const CHILD_POLL_MS = 3_000;

type Scope = {
  sessionIDs: Set<string>;
  acceptedChildren: Set<string>;
  /** Mutable cache of both sets, returned to the responder on every ask. */
  allowedSessionIDs: Set<string>;
  stop: () => void;
};

const scopes = new Map<string, Scope>();

function scopeKey(serverId: string, directory: string): string {
  return `${serverId}\0${directory}`;
}

export function registerPermissionSession(
  serverId: string,
  directory: string,
  sessionId: string,
  policy?: ExternalDirectoryPolicy,
): void {
  const key = scopeKey(serverId, directory);
  let scope = scopes.get(key);
  if (!scope) {
    const server = getServer(serverId);
    if (!server) throw new Error(`OpenCode server is not registered: ${serverId}`);
    if (!server.permissionScopesEnabled) return;
    const client = createOpencodeClient({
      baseUrl: server.baseUrl,
      fetch: fetchWithDeadline,
      directory,
    });
    const sessionIDs = new Set<string>();
    const acceptedChildren = new Set<string>();
    const allowedSessionIDs = new Set<string>();

    const acceptChild = (childId: string) => {
      if (acceptedChildren.has(childId)) return;
      acceptedChildren.add(childId);
      allowedSessionIDs.add(childId);
    };

    const pollChildren = async () => {
      const known = new Set([...sessionIDs, ...acceptedChildren]);
      for (const id of known) {
        try {
          const response = await client.session.children({ path: { id } });
          const error = sdkResponseError(response);
          if (error) throw error;
          for (const child of response.data ?? []) acceptChild(child.id);
        } catch (error) {
          console.error("OpenCode child session poll error:", error);
        }
      }
    };

    const childPoll = setInterval(() => {
      void pollChildren();
    }, CHILD_POLL_MS);
    childPoll.unref?.();

    const responder = startPermissionResponder(client, {
      policy: policy ?? server.permissionPolicy,
      allowedSessionIDs: () => allowedSessionIDs,
      onError: (error) => console.error("OpenCode permission responder error:", error),
      baseUrl: server.baseUrl,
      directory,
      rootDirectory: server.directory,
    });
    scope = {
      sessionIDs,
      acceptedChildren,
      allowedSessionIDs,
      stop: () => {
        clearInterval(childPoll);
        responder.stop();
      },
    };
    scopes.set(key, scope);
  }
  scope.sessionIDs.add(sessionId);
  scope.allowedSessionIDs.add(sessionId);
}

export function unregisterPermissionSession(
  serverId: string,
  directory: string,
  sessionId: string,
): void {
  const key = scopeKey(serverId, directory);
  const scope = scopes.get(key);
  if (!scope) return;
  scope.sessionIDs.delete(sessionId);
  if (scope.sessionIDs.size === 0) {
    scope.stop();
    scopes.delete(key);
  }
}

export function stopPermissionScope(serverId: string, directory: string): void {
  const key = scopeKey(serverId, directory);
  const scope = scopes.get(key);
  if (!scope) return;
  scope.stop();
  scopes.delete(key);
}

export function stopPermissionScopesForServer(serverId: string): void {
  for (const [key, scope] of scopes) {
    if (!key.startsWith(`${serverId}\0`)) continue;
    scope.stop();
    scopes.delete(key);
  }
}

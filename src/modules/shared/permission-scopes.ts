import { createOpencodeClient } from "@opencode-ai/sdk";
import { fetchWithDeadline } from "./opencode-client.js";
import { type ExternalDirectoryPolicy, startPermissionResponder } from "./permissions.js";
import { getServer } from "./server-registry.js";

type Scope = {
  sessionIDs: Set<string>;
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
    const sessionIDs = new Set<string>();
    const responder = startPermissionResponder(
      createOpencodeClient({
        baseUrl: server.baseUrl,
        fetch: fetchWithDeadline,
        directory,
      }),
      {
        policy: policy ?? server.permissionPolicy,
        allowedSessionIDs: () => sessionIDs,
        onError: (error) => console.error("OpenCode permission responder error:", error),
      },
    );
    scope = { sessionIDs, stop: responder.stop };
    scopes.set(key, scope);
  }
  scope.sessionIDs.add(sessionId);
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

import { and, eq, isNull } from "drizzle-orm";
import { getDb, getInstanceId, withImmediateTx } from "./db/index.js";
import { servers as serversTable } from "./db/schema.js";

export interface OpencodeServerInstance {
  serverId: string;
  baseUrl: string;
  close: () => void;
  /** Canonical directory inherited by the OpenCode server process. */
  directory?: string;
  permissionPolicy?: "read-only" | "allow" | "deny";
  permissionScopesEnabled?: boolean;
}

const servers = new Map<string, OpencodeServerInstance>();

export function registerServer(instance: OpencodeServerInstance) {
  servers.set(instance.serverId, instance);
  try {
    withImmediateTx(() => {
      getDb()
        .insert(serversTable)
        .values({
          serverId: instance.serverId,
          ownerInstanceId: getInstanceId(),
          baseUrl: instance.baseUrl,
          directory: instance.directory ?? "",
          permissionPolicy: instance.permissionPolicy ?? "read-only",
          startedAt: Date.now(),
          stoppedAt: null,
        })
        .onConflictDoUpdate({
          target: serversTable.serverId,
          set: {
            ownerInstanceId: getInstanceId(),
            baseUrl: instance.baseUrl,
            directory: instance.directory ?? "",
            permissionPolicy: instance.permissionPolicy ?? "read-only",
            stoppedAt: null,
          },
        })
        .run();
    });
  } catch {
    // Persisting server metadata must never break registration.
  }
}

export function getServer(serverId: string): OpencodeServerInstance | undefined {
  return servers.get(serverId);
}

export function removeServer(serverId: string) {
  servers.delete(serverId);
  try {
    withImmediateTx(() => {
      getDb()
        .update(serversTable)
        .set({ stoppedAt: Date.now() })
        .where(and(eq(serversTable.serverId, serverId), isNull(serversTable.stoppedAt)))
        .run();
    });
  } catch {
    // Persisting server metadata must never break removal.
  }
}

export function killAllServers() {
  const ids = [...servers.keys()];
  for (const instance of servers.values()) {
    instance.close();
  }
  servers.clear();
  for (const id of ids) {
    try {
      withImmediateTx(() => {
        getDb()
          .update(serversTable)
          .set({ stoppedAt: Date.now() })
          .where(and(eq(serversTable.serverId, id), isNull(serversTable.stoppedAt)))
          .run();
      });
    } catch {
      // Persisting server metadata must never break shutdown.
    }
  }
}

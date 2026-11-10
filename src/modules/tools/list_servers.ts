import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asc, inArray } from "drizzle-orm";
import { getDb, getInstanceId } from "../shared/db/index.js";
import { servers as serversTable, taskRuns, tasks } from "../shared/db/schema.js";
import { jsonResult } from "../shared/mcp-result.js";

export function registerOpencodeListServers(server: McpServer) {
  server.registerTool(
    "opencode_list_servers",
    {
      description:
        "List every OpenCode server known to this host (active and stopped) with its base URL, port, directory, owner, liveness, and task/session aggregates. Call this BEFORE opencode_start_server to find active servers/ports and avoid duplicate spawns.",
      inputSchema: {},
    },
    async () => {
      const rows = getDb().select().from(serversTable).orderBy(asc(serversTable.startedAt)).all();

      const instanceId = getInstanceId();

      const allTaskRows = getDb().select().from(tasks).all();
      const runIds = [
        ...new Set(
          allTaskRows
            .map((row) => row.currentRunId)
            .filter((value): value is string => value !== null),
        ),
      ];
      const runRows =
        runIds.length > 0
          ? getDb().select().from(taskRuns).where(inArray(taskRuns.runId, runIds)).all()
          : [];
      const runById = new Map(runRows.map((row) => [row.runId, row]));

      const tasksByServer = new Map<string, typeof allTaskRows>();
      for (const taskRow of allTaskRows) {
        const bucket = tasksByServer.get(taskRow.serverId);
        if (bucket) bucket.push(taskRow);
        else tasksByServer.set(taskRow.serverId, [taskRow]);
      }

      const aggregates = new Map<
        string,
        { tasks_total: number; sessions_total: number; tasks_active: number }
      >();
      for (const [serverId, taskRows] of tasksByServer) {
        const sessions = new Set(taskRows.map((row) => row.sessionId));
        let active = 0;
        for (const taskRow of taskRows) {
          if (taskRow.cancelledAt !== null) continue;
          if (taskRow.currentRunId === null) continue;
          const run = runById.get(taskRow.currentRunId);
          if (!run) continue;
          if (run.finalizedAt !== null) continue;
          if (run.cancelledAt !== null) continue;
          active += 1;
        }
        aggregates.set(serverId, {
          tasks_total: taskRows.length,
          sessions_total: sessions.size,
          tasks_active: active,
        });
      }

      const serverEntries = await Promise.all(
        rows.map(async (row) => {
          const aggregate = aggregates.get(row.serverId) ?? {
            tasks_total: 0,
            sessions_total: 0,
            tasks_active: 0,
          };
          const stopped = row.stoppedAt !== null;
          const port = Number(new URL(row.baseUrl).port);
          const base = {
            server_id: row.serverId,
            base_url: row.baseUrl,
            port,
            directory: row.directory,
            permission_policy: row.permissionPolicy,
            owner_instance_id: row.ownerInstanceId,
            owned_by_this_process: row.ownerInstanceId === instanceId,
            stopped,
            started_at: row.startedAt,
            stopped_at: row.stoppedAt,
            tasks_total: aggregate.tasks_total,
            sessions_total: aggregate.sessions_total,
            tasks_active: aggregate.tasks_active,
          };
          if (stopped) {
            return { ...base, alive: false, reason: "stopped" };
          }
          try {
            const response = await fetch(row.baseUrl, {
              signal: AbortSignal.timeout(800),
            });
            void response;
            return { ...base, alive: true };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ...base, alive: false, reason };
          }
        }),
      );

      const activeCount = rows.filter((row) => row.stoppedAt === null).length;

      return jsonResult({
        servers: serverEntries,
        active_count: activeCount,
        total_count: rows.length,
      });
    },
  );
}

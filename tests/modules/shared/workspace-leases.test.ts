import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInstanceId, getRawDb, resetDbForTests } from "../../../src/modules/shared/db/index.js";
import {
  pruneTerminalTaskRuns,
  releaseWorkspace,
  reserveWorkspace,
} from "../../../src/modules/shared/execution-report.js";

const ORIGINAL_DB_ENV = process.env.OPENCODE_MCP_HISTORY_DB;
const DAY_MS = 24 * 60 * 60 * 1000;

let directory: string;
let dbDirectory: string;

beforeEach(async () => {
  resetDbForTests();
  dbDirectory = await mkdtemp(path.join(os.tmpdir(), "workspace-lease-db-"));
  process.env.OPENCODE_MCP_HISTORY_DB = path.join(dbDirectory, "history.sqlite");
  directory = await mkdtemp(path.join(os.tmpdir(), "workspace-lease-root-"));
});

afterEach(async () => {
  resetDbForTests();
  if (ORIGINAL_DB_ENV === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
  else process.env.OPENCODE_MCP_HISTORY_DB = ORIGINAL_DB_ENV;
  await rm(directory, { recursive: true, force: true });
  await rm(dbDirectory, { recursive: true, force: true });
});

function requiredLease(token: symbol | undefined): symbol {
  if (!token) throw new Error("expected workspace lease");
  return token;
}

function insertInstance(
  instanceId: string,
  options: { pid?: number; stoppedAt?: number; heartbeatAt?: number } = {},
): void {
  const now = Date.now();
  getRawDb()
    .prepare(
      "INSERT INTO mcp_instances (instance_id, pid, process_started_at, heartbeat_at, stopped_at, version) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      instanceId,
      options.pid ?? process.pid,
      now,
      options.heartbeatAt ?? now,
      options.stoppedAt ?? null,
      "test",
    );
}

function insertLease(
  root: string,
  options: {
    exclusive?: boolean;
    runId?: string | null;
    ownerInstanceId?: string;
    ownerPid?: number;
  } = {},
): string {
  const leaseId = randomUUID();
  getRawDb()
    .prepare(
      "INSERT INTO workspace_leases (lease_id, workspace_root, exclusive, run_id, owner_instance_id, owner_pid, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      leaseId,
      realpathSync(root),
      options.exclusive ? 1 : 0,
      options.runId ?? null,
      options.ownerInstanceId ?? "missing-instance",
      options.ownerPid ?? 2_147_483_647,
      Date.now(),
    );
  return leaseId;
}

function insertRun(
  runId: string,
  taskId: string,
  overrides: {
    dispatchState?: "dispatching" | "accepted" | "uncertain" | "rejected";
    executionState?: string | null;
    reportReady?: boolean;
    finalizedAt?: number | null;
    workspaceId?: string | null;
  } = {},
): void {
  const raw = getRawDb();
  raw
    .prepare(
      "INSERT OR IGNORE INTO tasks (task_id, server_id, session_id, workspace_id, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(taskId, "server-1", "session-1", overrides.workspaceId ?? null, 1, 1);
  raw
    .prepare(
      "INSERT INTO task_runs (run_id, task_id, message_id, started_at, finalized_at, dispatch_state, execution_state, report_ready) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      runId,
      taskId,
      `msg_${runId}`,
      1,
      overrides.finalizedAt ?? null,
      overrides.dispatchState ?? "accepted",
      overrides.executionState ?? null,
      overrides.reportReady ? 1 : 0,
    );
}

function insertWorkspaceRow(workspaceId: string, state: "active" | "cleaning" | "removed"): void {
  getRawDb()
    .prepare(
      "INSERT INTO workspaces (workspace_id, server_id, source_directory, repository_directory, worktree_directory, execution_directory, base_commit, source_dirty, state, owner_instance_id, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .run(
      workspaceId,
      "server-1",
      "/src",
      "/repo",
      "/wt",
      "/exec",
      "abc",
      0,
      state,
      getInstanceId(),
      1,
    );
}

function leaseCount(): number {
  return (
    getRawDb().prepare("SELECT COUNT(*) AS count FROM workspace_leases").get() as {
      count: number;
    }
  ).count;
}

function runIds(): string[] {
  return (
    getRawDb().prepare("SELECT run_id FROM task_runs ORDER BY run_id").all() as Array<{
      run_id: string;
    }>
  ).map((row) => row.run_id);
}

describe("cross-process workspace leases", () => {
  it("reaps a conflicting lease whose owner instance stopped", async () => {
    insertInstance("stopped-instance", { stoppedAt: Date.now() });
    const staleLeaseId = insertLease(directory, {
      exclusive: true,
      ownerInstanceId: "stopped-instance",
    });

    const token = requiredLease(await reserveWorkspace(directory, true));

    expect(leaseCount()).toBe(1);
    const remaining = getRawDb().prepare("SELECT lease_id FROM workspace_leases").get() as {
      lease_id: string;
    };
    expect(remaining.lease_id).not.toBe(staleLeaseId);
    releaseWorkspace(token);
    expect(leaseCount()).toBe(0);
  });

  it("reaps a conflicting lease without a registered instance row", async () => {
    insertLease(directory, { exclusive: true, ownerInstanceId: "missing-instance" });
    const token = requiredLease(await reserveWorkspace(directory, true));
    releaseWorkspace(token);
    expect(leaseCount()).toBe(0);
  });

  it("reaps a conflicting lease whose owner pid is dead", async () => {
    insertInstance("dead-pid-instance", { pid: 424_242 });
    insertLease(directory, { exclusive: true, ownerInstanceId: "dead-pid-instance" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    try {
      const token = requiredLease(await reserveWorkspace(directory, true));
      releaseWorkspace(token);
    } finally {
      killSpy.mockRestore();
    }
    expect(leaseCount()).toBe(0);
  });

  it("reaps a lease whose live pid carries a stale heartbeat", async () => {
    insertInstance("pid-reused-instance", { heartbeatAt: Date.now() - 8 * DAY_MS });
    insertLease(directory, { exclusive: true, ownerInstanceId: "pid-reused-instance" });
    const token = requiredLease(await reserveWorkspace(directory, true));
    releaseWorkspace(token);
    expect(leaseCount()).toBe(0);
  });

  it("refuses to reclaim a lease held by a live registered instance", async () => {
    insertInstance("live-instance");
    insertLease(directory, { exclusive: true, ownerInstanceId: "live-instance" });

    expect(await reserveWorkspace(directory, true)).toBeUndefined();
    expect(leaseCount()).toBe(1);
  });

  it("treats a dead owner's uncertain run as live and keeps its lease", async () => {
    insertRun("uncertain-run", "uncertain-task", { dispatchState: "uncertain" });
    insertLease(directory, {
      exclusive: true,
      runId: "uncertain-run",
      ownerInstanceId: "dead-uncertain-instance",
    });

    expect(await reserveWorkspace(directory, true)).toBeUndefined();
    expect(leaseCount()).toBe(1);
    expect(runIds()).toEqual(["uncertain-run"]);
  });

  it("reaps a dead owner when the linked run is terminal and no instance row exists", async () => {
    insertRun("accepted-run", "accepted-task", { dispatchState: "accepted" });
    insertLease(directory, {
      exclusive: true,
      runId: "accepted-run",
      ownerInstanceId: "missing-run-instance",
    });

    const token = requiredLease(await reserveWorkspace(directory, true));

    expect(leaseCount()).toBe(1);
    expect(runIds()).toEqual(["accepted-run"]);
    releaseWorkspace(token);
  });

  it("reaps a dead owner whose linked run is absent from task_runs", async () => {
    insertLease(directory, {
      exclusive: true,
      runId: "missing-run",
      ownerInstanceId: "dead-run-instance",
    });

    const token = requiredLease(await reserveWorkspace(directory, true));
    releaseWorkspace(token);
    expect(leaseCount()).toBe(0);
  });

  it("links a reserved lease to a caller-supplied run id", async () => {
    const token = requiredLease(await reserveWorkspace(directory, true, "run-link"));
    const row = getRawDb()
      .prepare("SELECT run_id, owner_instance_id, owner_pid FROM workspace_leases")
      .get() as { run_id: string; owner_instance_id: string; owner_pid: number };
    expect(row).toEqual({
      run_id: "run-link",
      owner_instance_id: getInstanceId(),
      owner_pid: process.pid,
    });
    releaseWorkspace(token);
  });
});

describe("workspace overlap rules across processes", () => {
  it("conflicts on identical, parent, and child roots but not siblings", async () => {
    insertInstance("live-instance");
    const child = path.join(directory, "child");
    await mkdir(child);
    const sibling = await mkdtemp(path.join(os.tmpdir(), "workspace-lease-sibling-"));
    try {
      insertLease(directory, { exclusive: true, ownerInstanceId: "live-instance" });

      expect(await reserveWorkspace(directory, true)).toBeUndefined();
      expect(await reserveWorkspace(child, true)).toBeUndefined();

      const freeSibling = requiredLease(await reserveWorkspace(sibling, true));
      releaseWorkspace(freeSibling);

      getRawDb()
        .prepare("DELETE FROM workspace_leases WHERE workspace_root = ?")
        .run(realpathSync(directory));
      insertLease(child, { exclusive: true, ownerInstanceId: "live-instance" });
      expect(await reserveWorkspace(directory, true)).toBeUndefined();
      expect(await reserveWorkspace(directory, false)).toBeUndefined();
      getRawDb().prepare("DELETE FROM workspace_leases").run();
      const sharedParent = requiredLease(await reserveWorkspace(directory, false));
      expect(sharedParent).toBeDefined();
      releaseWorkspace(sharedParent);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("lets shared leases coexist while any exclusive lease blocks", async () => {
    insertInstance("live-instance");
    insertLease(directory, { exclusive: false, ownerInstanceId: "live-instance" });

    const shared = requiredLease(await reserveWorkspace(directory, false));
    expect(await reserveWorkspace(directory, true)).toBeUndefined();
    releaseWorkspace(shared);
    expect(await reserveWorkspace(directory, true)).toBeUndefined();

    getRawDb().prepare("DELETE FROM workspace_leases").run();
    const exclusive = requiredLease(await reserveWorkspace(directory, true));
    expect(await reserveWorkspace(directory, false)).toBeUndefined();
    releaseWorkspace(exclusive);
  });
});

describe("workspace lease release", () => {
  it("removes the durable row and tolerates repeated or unknown releases", async () => {
    const token = requiredLease(await reserveWorkspace(directory, true));
    expect(leaseCount()).toBe(1);

    releaseWorkspace(token);
    expect(leaseCount()).toBe(0);
    releaseWorkspace(token);
    releaseWorkspace(Symbol("never reserved"));
    expect(leaseCount()).toBe(0);
  });
});

describe("terminal run retention", () => {
  it("prunes only finalized terminal runs older than the TTL", () => {
    const now = Date.now();
    const ttl = 60_000;
    const old = now - 2 * ttl;
    const fresh = now - 1_000;
    const raw = getRawDb();

    insertRun("prunable", "task-a", {
      executionState: "completed",
      reportReady: true,
      finalizedAt: old,
    });
    insertRun("keep-fresh", "task-a", {
      executionState: "completed",
      reportReady: true,
      finalizedAt: fresh,
    });
    insertRun("keep-uncertain", "task-a", {
      dispatchState: "uncertain",
      executionState: "completed",
      reportReady: true,
      finalizedAt: old,
    });
    insertRun("keep-unfinalized", "task-a", { reportReady: true, finalizedAt: null });
    insertRun("keep-not-reported", "task-a", { finalizedAt: old, reportReady: false });
    insertRun("keep-running", "task-a", {
      executionState: "running",
      reportReady: true,
      finalizedAt: old,
    });
    insertRun("keep-pending", "task-a", {
      executionState: "pending",
      reportReady: true,
      finalizedAt: old,
    });
    insertRun("keep-active-workspace", "task-active", {
      executionState: "completed",
      reportReady: true,
      finalizedAt: old,
      workspaceId: "ws-active",
    });
    insertRun("prune-removed-workspace", "task-removed", {
      executionState: "completed",
      reportReady: true,
      finalizedAt: old,
      workspaceId: "ws-removed",
    });
    insertRun("prune-missing-workspace", "task-missing", {
      executionState: "completed",
      reportReady: true,
      finalizedAt: old,
      workspaceId: "ws-missing",
    });

    insertWorkspaceRow("ws-active", "active");
    insertWorkspaceRow("ws-removed", "removed");
    raw
      .prepare("INSERT INTO workspace_baselines (run_id, relative_path, sha256) VALUES (?, ?, ?)")
      .run("prunable", "a.txt", "hash-a");

    expect(pruneTerminalTaskRuns(ttl)).toBe(3);

    expect(runIds()).toEqual([
      "keep-active-workspace",
      "keep-fresh",
      "keep-not-reported",
      "keep-pending",
      "keep-running",
      "keep-uncertain",
      "keep-unfinalized",
    ]);
    const baselines = (
      raw
        .prepare("SELECT COUNT(*) AS count FROM workspace_baselines WHERE run_id = ?")
        .get("prunable") as { count: number }
    ).count;
    expect(baselines).toBe(0);
  });

  it("returns zero when no terminal runs are eligible", () => {
    insertRun("recent", "task-b", {
      executionState: "completed",
      reportReady: true,
      finalizedAt: Date.now(),
    });
    expect(pruneTerminalTaskRuns(60_000)).toBe(0);
    expect(runIds()).toEqual(["recent"]);
  });
});

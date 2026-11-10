import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDb,
  getDb,
  getInstanceId,
  getRawDb,
  isInstanceAlive,
  resetDbForTests,
  resolveDbPath,
  resolvePackageVersion,
  updateInstanceHeartbeat,
  withImmediateTx,
} from "../../../src/modules/shared/db/index.js";
import * as schema from "../../../src/modules/shared/db/schema.js";

const EXPECTED_TABLES = [
  "mcp_instances",
  "servers",
  "workspaces",
  "tasks",
  "task_runs",
  "workspace_baselines",
  "usage_ledger",
  "quota_snapshots",
  "workspace_leases",
  "task_dispatch_leases",
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const repoVersion = () =>
  (
    JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;

let root: string;
let dbPath: string;

function tableNames(): string[] {
  return (
    getRawDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function insertInstance(input: {
  instanceId: string;
  pid: number;
  heartbeatAt?: number;
  stoppedAt?: number | null;
}): void {
  getRawDb()
    .prepare(
      "INSERT INTO mcp_instances (instance_id, pid, process_started_at, heartbeat_at, stopped_at, version) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.instanceId,
      input.pid,
      Date.now(),
      input.heartbeatAt ?? Date.now(),
      input.stoppedAt ?? null,
      "test",
    );
}

beforeEach(() => {
  resetDbForTests();
  root = mkdtempSync(join(tmpdir(), "opencode-mcp-db-"));
  dbPath = join(root, "state", "history.sqlite");
  process.env.OPENCODE_MCP_HISTORY_DB = dbPath;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.OPENCODE_MCP_HISTORY_DB;
  delete process.env.XDG_STATE_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("resolveDbPath", () => {
  it("prefers OPENCODE_MCP_HISTORY_DB", () => {
    process.env.OPENCODE_MCP_HISTORY_DB = ":memory:";
    expect(resolveDbPath()).toBe(":memory:");
  });

  it("falls through when the override is blank", () => {
    process.env.OPENCODE_MCP_HISTORY_DB = "   ";
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    expect(resolveDbPath()).toBe(join("/tmp/xdg-state", "opencode-mcp", "history.sqlite"));
  });

  it("uses XDG_STATE_HOME when set", () => {
    delete process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    expect(resolveDbPath()).toBe(join("/tmp/xdg-state", "opencode-mcp", "history.sqlite"));
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is blank", () => {
    delete process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.XDG_STATE_HOME = "  ";
    expect(resolveDbPath()).toBe(
      join(homedir(), ".local", "state", "opencode-mcp", "history.sqlite"),
    );
  });
});

describe("bootstrap", () => {
  it("opens an in-memory database with all tables, pragmas, and the process row", () => {
    process.env.OPENCODE_MCP_HISTORY_DB = ":memory:";
    const raw = getRawDb();

    expect(tableNames()).toEqual([...EXPECTED_TABLES].sort());
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(raw.pragma("busy_timeout", { simple: true })).toBe(5_000);

    const rows = getDb().select().from(schema.mcpInstances).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instanceId: getInstanceId(),
      pid: process.pid,
      version: repoVersion(),
      stoppedAt: null,
    });
  });

  it("creates the parent directory with private permissions for file databases", () => {
    getRawDb();
    expect(existsSync(dbPath)).toBe(true);
    const mode = statSync(dirname(dbPath)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("applies WAL journaling for file databases", () => {
    expect(getRawDb().pragma("journal_mode", { simple: true })).toBe("wal");
    expect(getRawDb().pragma("synchronous", { simple: true })).toBe(1);
  });

  it("applies column defaults and foreign key cascades", () => {
    const raw = getRawDb();
    raw
      .prepare(
        "INSERT INTO tasks (task_id, server_id, session_id, created_at, started_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("task-1", "server-1", "session-1", 1, 1);
    raw
      .prepare(
        "INSERT INTO task_runs (run_id, task_id, message_id, started_at, dispatch_state) VALUES (?, ?, ?, ?, ?)",
      )
      .run("run-1", "task-1", "msg_1", 1, "accepted");

    const run = raw.prepare("SELECT * FROM task_runs WHERE run_id = ?").get("run-1") as {
      report_ready: number;
      finalization_started: number;
      observer_generation: number;
    };
    expect(run).toMatchObject({
      report_ready: 0,
      finalization_started: 0,
      observer_generation: 0,
    });

    raw.prepare("DELETE FROM tasks WHERE task_id = ?").run("task-1");
    expect(raw.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({ count: 0 });
  });

  it("keeps user_version at 1 across re-initialization", () => {
    getRawDb();
    expect(getRawDb().pragma("user_version", { simple: true })).toBe(1);
    closeDb();

    getRawDb();
    expect(getRawDb().pragma("user_version", { simple: true })).toBe(1);
    const count = getRawDb().prepare("SELECT COUNT(*) AS count FROM mcp_instances").get() as {
      count: number;
    };
    expect(count.count).toBe(2);
  });
});

describe("schema foreign keys", () => {
  it("resolves cascade references to their foreign tables", () => {
    const runForeignKey = getTableConfig(schema.taskRuns).foreignKeys[0];
    const runReference = runForeignKey.reference();
    expect(runReference.foreignTable).toBe(schema.tasks);
    expect(runReference.columns.map((column) => column.name)).toEqual(["task_id"]);
    expect(runForeignKey.onDelete).toBe("cascade");

    const baselineForeignKey = getTableConfig(schema.workspaceBaselines).foreignKeys[0];
    const baselineReference = baselineForeignKey.reference();
    expect(baselineReference.foreignTable).toBe(schema.taskRuns);
    expect(baselineReference.columns.map((column) => column.name)).toEqual(["run_id"]);
    expect(baselineForeignKey.onDelete).toBe("cascade");
  });
});

describe("persistence", () => {
  it("persists rows across close and re-open", () => {
    getRawDb()
      .prepare(
        "INSERT INTO servers (server_id, owner_instance_id, base_url, directory, permission_policy, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("server-1", getInstanceId(), "http://localhost:4096", "/tmp/project", "read-only", 42);

    closeDb();
    expect(
      getRawDb().prepare("SELECT base_url FROM servers WHERE server_id = ?").get("server-1"),
    ).toEqual({ base_url: "http://localhost:4096" });
  });
});

describe("withImmediateTx", () => {
  it("commits when the callback succeeds", () => {
    getRawDb();
    withImmediateTx(() => {
      getRawDb()
        .prepare(
          "INSERT INTO quota_snapshots (id, source, fetched_at, spend_budget, models) VALUES (?, ?, ?, ?, ?)",
        )
        .run("opencode-go", "https://example.test", "2026-01-01T00:00:00.000Z", "{}", "[]");
    });
    expect(getRawDb().prepare("SELECT COUNT(*) AS count FROM quota_snapshots").get()).toEqual({
      count: 1,
    });
  });

  it("rolls back and rethrows when the callback throws", () => {
    getRawDb();
    expect(() =>
      withImmediateTx(() => {
        getRawDb()
          .prepare(
            "INSERT INTO quota_snapshots (id, source, fetched_at, spend_budget, models) VALUES (?, ?, ?, ?, ?)",
          )
          .run("opencode-go", "https://example.test", "2026-01-01T00:00:00.000Z", "{}", "[]");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getRawDb().prepare("SELECT COUNT(*) AS count FROM quota_snapshots").get()).toEqual({
      count: 0,
    });
  });
});

describe("instance lifecycle", () => {
  it("returns a stable instance id", () => {
    const first = getInstanceId();
    expect(first).toMatch(UUID_PATTERN);
    expect(getInstanceId()).toBe(first);
  });

  it("writes stopped_at on closeDb", () => {
    const instanceId = getInstanceId();
    closeDb();

    const row = getRawDb()
      .prepare("SELECT stopped_at FROM mcp_instances WHERE instance_id = ?")
      .get(instanceId) as { stopped_at: number | null };
    expect(typeof row.stopped_at).toBe("number");
  });

  it("treats closeDb as a no-op when no database is open", () => {
    resetDbForTests();
    expect(() => closeDb()).not.toThrow();
  });

  it("resetDbForTests allows re-initialization without writing stopped_at", () => {
    const first = getInstanceId();
    resetDbForTests();

    expect(getInstanceId()).not.toBe(first);
    const row = getRawDb()
      .prepare("SELECT stopped_at FROM mcp_instances WHERE instance_id = ?")
      .get(first) as { stopped_at: number | null };
    expect(row.stopped_at).toBeNull();
  });

  it("treats resetDbForTests as a no-op when no database is open", () => {
    resetDbForTests();
    expect(() => resetDbForTests()).not.toThrow();
  });

  it("updates the heartbeat when open and is a no-op when closed", () => {
    resetDbForTests();
    expect(() => updateInstanceHeartbeat()).not.toThrow();

    const instanceId = getInstanceId();
    getRawDb()
      .prepare("UPDATE mcp_instances SET heartbeat_at = 1 WHERE instance_id = ?")
      .run(instanceId);
    updateInstanceHeartbeat();

    const row = getRawDb()
      .prepare("SELECT heartbeat_at FROM mcp_instances WHERE instance_id = ?")
      .get(instanceId) as { heartbeat_at: number };
    expect(row.heartbeat_at).toBeGreaterThan(1);
  });
});

describe("isInstanceAlive", () => {
  it("returns false for an unknown instance", () => {
    getRawDb();
    expect(isInstanceAlive("missing-instance")).toBe(false);
  });

  it("returns false for a stopped instance", () => {
    getRawDb();
    insertInstance({ instanceId: "stopped", pid: process.pid, stoppedAt: 123 });
    expect(isInstanceAlive("stopped")).toBe(false);
  });

  it("returns true for a live process with a fresh heartbeat", () => {
    getRawDb();
    insertInstance({ instanceId: "live", pid: process.pid, heartbeatAt: Date.now() });
    expect(isInstanceAlive("live")).toBe(true);
  });

  it("returns false for a dead pid", () => {
    getRawDb();
    insertInstance({ instanceId: "dead", pid: 2_147_483_647, heartbeatAt: Date.now() });
    expect(isInstanceAlive("dead")).toBe(false);
  });

  it("returns false for a reused pid with a stale heartbeat", () => {
    getRawDb();
    insertInstance({
      instanceId: "stale",
      pid: process.pid,
      heartbeatAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    expect(isInstanceAlive("stale")).toBe(false);
  });
});

describe("resolvePackageVersion", () => {
  it("walks upward to the nearest package.json", () => {
    const pkgDir = join(root, "fixture");
    const nested = join(pkgDir, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(resolvePackageVersion(nested)).toBe("9.9.9");
  });

  it("returns unknown when no package.json exists up to the root", () => {
    expect(resolvePackageVersion("/")).toBe("unknown");
  });

  it("skips malformed package.json files", () => {
    const dir = join(root, "malformed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(resolvePackageVersion(dir)).toBe("unknown");
  });

  it("skips package.json files without a string version", () => {
    const dir = join(root, "no-version");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: 42 }));
    expect(resolvePackageVersion(dir)).toBe("unknown");
  });

  it("defaults to the module directory", () => {
    expect(resolvePackageVersion()).toBe(repoVersion());
  });
});

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const PID_REUSE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DDL = `
CREATE TABLE IF NOT EXISTS mcp_instances (
  instance_id TEXT PRIMARY KEY NOT NULL,
  pid INTEGER NOT NULL,
  process_started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  stopped_at INTEGER,
  version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  server_id TEXT PRIMARY KEY NOT NULL,
  owner_instance_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  directory TEXT NOT NULL,
  permission_policy TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER
);
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL,
  source_directory TEXT NOT NULL,
  repository_directory TEXT NOT NULL,
  worktree_directory TEXT NOT NULL,
  execution_directory TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  source_dirty INTEGER NOT NULL,
  state TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY NOT NULL,
  server_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  directory TEXT,
  workspace_id TEXT,
  workspace_metadata TEXT,
  current_run_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  agent_name TEXT,
  requested_provider_id TEXT,
  requested_model_id TEXT,
  started_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  finalized_at INTEGER,
  dispatch_state TEXT NOT NULL,
  dispatch_error TEXT,
  execution_state TEXT,
  report_ready INTEGER NOT NULL DEFAULT 0,
  finalization_started INTEGER NOT NULL DEFAULT 0,
  finalization_error TEXT,
  baseline_root TEXT,
  baseline_error TEXT,
  expected_changes TEXT,
  checks TEXT,
  report TEXT,
  usage TEXT,
  result TEXT,
  observer_instance_id TEXT,
  observer_generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_baselines (
  run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (run_id, relative_path)
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  run_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  reported_cost REAL,
  complete INTEGER NOT NULL,
  breakdown TEXT
);
CREATE INDEX IF NOT EXISTS usage_ledger_captured_at_idx ON usage_ledger (captured_at);
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  spend_budget TEXT NOT NULL,
  models TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_leases (
  lease_id TEXT PRIMARY KEY NOT NULL,
  workspace_root TEXT NOT NULL,
  exclusive INTEGER NOT NULL,
  run_id TEXT,
  owner_instance_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_leases_workspace_root_idx ON workspace_leases (workspace_root);
CREATE TABLE IF NOT EXISTS task_dispatch_leases (
  task_id TEXT PRIMARY KEY NOT NULL,
  owner_instance_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL
);
`;

type RawDatabase = InstanceType<typeof Database>;

type DbState = {
  sqlite: RawDatabase;
  db: BetterSQLite3Database<typeof schema>;
  instanceId: string;
};

let state: DbState | undefined;
let cachedPackageVersion: string | undefined;

export function resolveDbPath(): string {
  const override = process.env.OPENCODE_MCP_HISTORY_DB?.trim();
  if (override) return override;

  const stateHome = process.env.XDG_STATE_HOME?.trim();
  const base = stateHome ? stateHome : join(homedir(), ".local", "state");
  return join(base, "opencode-mcp", "history.sqlite");
}

function readVersionFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePackageVersion(startDirectory: string = MODULE_DIR): string {
  let dir = startDirectory;
  for (;;) {
    const version = readVersionFile(join(dir, "package.json"));
    if (version !== undefined) return version;
    const parent = dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

function packageVersion(): string {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;
  cachedPackageVersion = resolvePackageVersion();
  return cachedPackageVersion;
}

function migrate(sqlite: RawDatabase): void {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  sqlite.exec(
    ["BEGIN IMMEDIATE;", DDL, `PRAGMA user_version = ${SCHEMA_VERSION};`, "COMMIT;"].join("\n"),
  );
}

function open(): DbState {
  if (state) return state;

  const path = resolveDbPath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);

  migrate(sqlite);

  const instanceId = globalThis.crypto.randomUUID();
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO mcp_instances (instance_id, pid, process_started_at, heartbeat_at, stopped_at, version) VALUES (?, ?, ?, ?, NULL, ?)",
    )
    .run(instanceId, process.pid, now, now, packageVersion());

  state = { sqlite, db: drizzle(sqlite, { schema }), instanceId };
  return state;
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return open().db;
}

export function getRawDb(): RawDatabase {
  return open().sqlite;
}

export function getInstanceId(): string {
  return open().instanceId;
}

export function updateInstanceHeartbeat(): void {
  if (!state) return;
  state.sqlite
    .prepare("UPDATE mcp_instances SET heartbeat_at = ? WHERE instance_id = ?")
    .run(Date.now(), state.instanceId);
}

export function isInstanceAlive(instanceId: string): boolean {
  const row = getRawDb()
    .prepare("SELECT pid, heartbeat_at, stopped_at FROM mcp_instances WHERE instance_id = ?")
    .get(instanceId) as
    | { pid: number; heartbeat_at: number; stopped_at: number | null }
    | undefined;

  if (!row || row.stopped_at !== null) return false;

  try {
    process.kill(row.pid, 0);
  } catch {
    return false;
  }

  return Date.now() - row.heartbeat_at <= PID_REUSE_STALE_MS;
}

export function withImmediateTx<T>(fn: () => T): T {
  const sqlite = getRawDb();
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function closeDb(): void {
  if (!state) return;
  state.sqlite
    .prepare("UPDATE mcp_instances SET stopped_at = ? WHERE instance_id = ?")
    .run(Date.now(), state.instanceId);
  state.sqlite.close();
  state = undefined;
}

export function resetDbForTests(): void {
  if (!state) return;
  state.sqlite.close();
  state = undefined;
}

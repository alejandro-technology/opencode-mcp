# SQLite Persistence and Multi-Instance Coordination Plan (Drizzle ORM + `node:sqlite`)

**Status:** Approved planning specification (updated for v1.4.0+); ready for implementation in a dedicated build session.

This document consolidates the earlier persistence proposal (from post-1.3.1) with the architectural findings from **v1.4.0** (OpenCode 1.19.5 per-session MCP spawns, port walking, v2 REST permission drain, and model quota tiers) and locks in the technical stack: **Drizzle ORM (`drizzle-orm/node-sqlite`) over Node's built-in `node:sqlite` (`DatabaseSync`) with automatic SQL schema bootstrap**.

The database acts both as durable storage across MCP restarts and as the cross-process coordination point for workspace ownership, task/run history, workspace leases, and cumulative spend/quota tracking across multiple `opencode-mcp` processes on the same host.

---

## 1. Key Architectural Decisions (Locked In)

| Area | Decision | Rationale |
|---|---|---|
| **SQLite Driver** | Native `node:sqlite` (`DatabaseSync`) | Zero native C++ addons (`node-gyp` free), synchronous execution that preserves existing synchronous registry signatures (`getTask`, `workspaceMetadata`, etc.), and native `:memory:` support for fast Vitest suites. |
| **ORM & Query Layer** | `drizzle-orm` (`drizzle-orm/node-sqlite` + `drizzle-orm/sqlite-core`) | Strictly typed schema and queries (`text(..., { mode: "json" }).$type<T>()`), zero runtime overhead, and clean repository abstractions. |
| **Node.js Floor** | `"engines": { "node": ">=22.5.0" }` | `node:sqlite` is built into Node 22.5+ and CI already targets Node 22 and 24. |
| **Schema Initialization** | Code-embedded idempotent SQL auto-bootstrap + `PRAGMA user_version` | `package.json` publishes only `files: ["build", "CHANGELOG.md"]`. Running `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` inside a startup transaction avoids shipping or resolving external `.sql` migration folders in `npx`/global installs. |
| **Database Location** | `OPENCODE_MCP_HISTORY_DB` > `$XDG_STATE_HOME/opencode-mcp/history.sqlite` > `~/.local/state/opencode-mcp/history.sqlite` | Keeps durable state separate from disposable cache (`~/.cache/opencode-mcp/`), while supporting `:memory:` or temp files in tests. |
| **Scope** | Full 5-phase rollout (Foundation, Worktrees, Tasks/Runs/Baselines, Usage Ledger & Quotas, Cross-Process Leases) | Addresses every in-memory limitation identified in v1.4.0, including multi-process collisions caused by OpenCode spawning one `opencode-mcp` process per session directory. |

---

## 2. Current In-Memory State Inventory & Gaps (v1.4.0)

Today, almost all runtime state lives in process-local `Map` and `Set` structures under `src/modules/shared/`. Because OpenCode 1.19.x spawns a separate `opencode-mcp` child process per session `Location` (`cwd`), processes do not share memory and lose state on restart:

| Module | Current In-Memory Structure | Limitation / Failure Mode | SQLite Solution |
|---|---|---|---|
| `server-registry.ts` | `servers: Map<serverId, OpencodeServerInstance>` (`baseUrl`, `directory`, `permissionPolicy`, `close`) | Other MCP processes or restarted sessions cannot resolve an existing `serverId`. | Persist server metadata in `servers` (excluding the in-memory `close` callback; verify endpoint liveness before reuse). |
| `task-registry.ts` | `tasks: Map<taskId, TaskRecord>` & `dispatchReservations: Set<taskId>` | History, reports, cached results, and **`cancelledAt`** vanish on exit. Without `cancelledAt`, an aborted OpenCode session still has a `completed` timestamp on its last assistant message and is misreported as `completed`. | Persist `tasks`, `task_runs`, and `task_dispatch_leases` transactionally with durable `cancelled_at`. |
| `workspace-manager.ts` & `git-workspace.ts` | `workspaces: Map<workspaceId, ManagedWorkspaceRecord>` & `handles: Map<id, { workspace, runGit }>` | Managed worktrees in `~/.cache/opencode-mcp/workspaces/` become orphaned after a restart (`workspace_not_found` / `not_owned`). | Persist canonical paths and Git metadata in `workspaces`; re-hydrate handles on demand and validate Git identity before `worktree remove`. |
| `execution-report.ts` (Baselines) | `run.baseline: WorkspaceSnapshot` (`Map<relativePath, sha256>`, up to 20,000 files / 32 MiB per run) | Retained in V8 heap inside `TaskRunRecord` even after `reportReady = true`. | Store file hashes in `workspace_baselines` only while the run is active; delete rows immediately after `captureReport()` commits the final report. |
| `execution-report.ts` (Leases) | `reservations: Array<{ root, exclusive, token }>` | Only prevents overlapping verified runs within the **same** Node.js process. Two MCP processes can mutate/verify the same directory concurrently. | Persist path leases in `workspace_leases` using `BEGIN IMMEDIATE` transactions and PID/instance liveness checks. |
| `execution-usage.ts` & `usage-limits.ts` | Per-run `ExecutionUsageSnapshot` in RAM + `usage-limits.json` on disk | `opencode_list_agents` knows theoretical OpenCode Go limits (`$0.15/5h`, `$0.50/week`, req/5h), but has no visibility into cumulative tokens/cost already spent across runs in the current 5h/7d window. | Persist `usage_ledger` (indexed by timestamp and model) and `quota_snapshots` to expose rolling-window consumption in `opencode_list_agents`. |
| `permission-scopes.ts` & `run-observer.ts` | `scopes: Map`, `handled: Set`, `observers: Map`, `AbortController`, `ChildProcess` | Tied to OS sockets, timers, and child processes of the live Node process. | **Keep in memory**, backed by DB lease ownership (`observer_instance_id`, `generation`) so only one process observes/finalizes a run at a time. |

---

## 3. Connection Setup & Concurrency Rules (`src/modules/shared/db/index.ts`)

```typescript
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import * as schema from "./schema.js";
```

### Connection PRAGMAs
Applied immediately whenever `DatabaseSync` opens the database file:
- `PRAGMA journal_mode = WAL;` — concurrent reads across MCP instances with single-writer serialization.
- `PRAGMA synchronous = NORMAL;` (or `FULL` around critical dispatch commits).
- `PRAGMA foreign_keys = ON;` — enforces cascade cleanup of `workspace_baselines` and child rows.
- `PRAGMA busy_timeout = 5000;` — waits up to 5s on lock contention instead of failing immediately with `SQLITE_BUSY`.

### Transaction Rules for Synchronous `node:sqlite`
- Keep all transactions **synchronous and short** (`BEGIN IMMEDIATE ... COMMIT`).
- **Never** hold an open transaction across `await` boundaries (OpenCode HTTP calls, `git worktree` child spawns, recursive filesystem walks, or verification `checks`).
- Follow the 3-step durable pattern for external operations:
  1. Short synchronous write transaction: reserve lease / persist intent (`dispatch_state = "dispatching"` or `state = "cleaning"`).
  2. Perform async I/O outside the transaction (`promptAsync`, `captureWorkspace`, `git worktree remove`).
  3. Short synchronous write transaction: commit outcome (`accepted` / `uncertain` / `rejected`, `report`, `removed`).

---

## 4. Drizzle Schema Specification (`src/modules/shared/db/schema.ts`)

All tables are defined with `sqliteTable` from `drizzle-orm/sqlite-core`. Complex nested objects that are read/written as a unit use `text("...", { mode: "json" }).$type<T>()`.

### 4.1 `mcp_instances`
Tracks active and historical MCP processes sharing the SQLite file (protects against OS PID reuse by pairing `pid` with `process_started_at` and `heartbeat_at`):
- `instanceId`: `text("instance_id").primaryKey()` (UUID generated at process boot)
- `pid`: `integer("pid").notNull()`
- `processStartedAt`: `integer("process_started_at").notNull()`
- `heartbeatAt`: `integer("heartbeat_at").notNull()`
- `stoppedAt`: `integer("stopped_at")`
- `version`: `text("version").notNull()`

### 4.2 `servers`
Tracks spawned OpenCode servers (`opencode_start_server`):
- `serverId`: `text("server_id").primaryKey()`
- `ownerInstanceId`: `text("owner_instance_id").notNull()`
- `baseUrl`: `text("base_url").notNull()`
- `directory`: `text("directory").notNull()`
- `permissionPolicy`: `text("permission_policy", { enum: ["read-only", "allow", "deny"] }).notNull()`
- `startedAt`: `integer("started_at").notNull()`
- `stoppedAt`: `integer("stopped_at")`

### 4.3 `workspaces`
Preserves ownership and canonical Git identity of managed worktrees (`workspace-manager.ts` / `git-workspace.ts`):
- `workspaceId`: `text("workspace_id").primaryKey()`
- `serverId`: `text("server_id").notNull()`
- `sourceDirectory`: `text("source_directory").notNull()`
- `repositoryDirectory`: `text("repository_directory").notNull()`
- `worktreeDirectory`: `text("worktree_directory").notNull()`
- `executionDirectory`: `text("execution_directory").notNull()`
- `baseCommit`: `text("base_commit").notNull()`
- `sourceDirty`: `integer("source_dirty", { mode: "boolean" }).notNull()`
- `state`: `text("state", { enum: ["active", "cleaning", "removed"] }).notNull()`
- `ownerInstanceId`: `text("owner_instance_id").notNull()`
- `createdAt`: `integer("created_at").notNull()`
- `removedAt`: `integer("removed_at")`

### 4.4 `tasks`
Long-lived task record linked to an OpenCode session (`task-registry.ts`):
- `taskId`: `text("task_id").primaryKey()`
- `serverId`: `text("server_id").notNull()`
- `sessionId`: `text("session_id").notNull()`
- `directory`: `text("directory")`
- `workspaceId`: `text("workspace_id")`
- `workspaceMetadata`: `text("workspace_metadata", { mode: "json" }).$type<WorkspaceMetadata>()`
- `currentRunId`: `text("current_run_id")`
- `createdAt`: `integer("created_at").notNull()` (immutable first creation timestamp)
- `startedAt`: `integer("started_at").notNull()` (latest run start timestamp used for stall detection)
- `cancelledAt`: `integer("cancelled_at")`

### 4.5 `task_runs`
Per-prompt run lifecycle, verification definitions, finalized report, usage snapshot, and cached result:
- `runId`: `text("run_id").primaryKey()`
- `taskId`: `text("task_id").notNull().references(() => tasks.taskId, { onDelete: "cascade" })`
- `messageId`: `text("message_id").notNull().unique()` (must carry `msg_` prefix)
- `agentName`: `text("agent_name")`
- `requestedProviderId`: `text("requested_provider_id")`
- `requestedModelId`: `text("requested_model_id")`
- `startedAt`: `integer("started_at").notNull()`
- `cancelledAt`: `integer("cancelled_at")`
- `finalizedAt`: `integer("finalized_at")`
- `dispatchState`: `text("dispatch_state", { enum: ["dispatching", "accepted", "uncertain", "rejected"] }).notNull()`
- `dispatchError`: `text("dispatch_error")`
- `executionState`: `text("execution_state")`
- `reportReady`: `integer("report_ready", { mode: "boolean" }).notNull().default(false)`
- `finalizationStarted`: `integer("finalization_started", { mode: "boolean" }).notNull().default(false)`
- `finalizationError`: `text("finalization_error")`
- `baselineRoot`: `text("baseline_root")`
- `baselineError`: `text("baseline_error")`
- `expectedChanges`: `text("expected_changes", { mode: "json" }).$type<ExpectedChange[]>()`
- `checks`: `text("checks", { mode: "json" }).$type<VerificationCheck[]>()`
- `report`: `text("report", { mode: "json" }).$type<ExecutionReport>()`
- `usage`: `text("usage", { mode: "json" }).$type<ExecutionUsageSnapshot>()`
- `result`: `text("result", { mode: "json" }).$type<CachedTaskResult>()`
- `observerInstanceId`: `text("observer_instance_id")`
- `observerGeneration`: `integer("observer_generation").notNull().default(0)`

> **Privacy note:** Full prompt text is deliberately omitted by default (the OpenCode session already stores it, and prompts may contain secrets or large code blocks). `message_id` and `session_id` correlate the run with OpenCode.

### 4.6 `workspace_baselines`
Temporary SHA-256 file inventory captured before a run starts; deleted once `captureReport()` completes:
- `runId`: `text("run_id").notNull().references(() => taskRuns.runId, { onDelete: "cascade" })`
- `relativePath`: `text("relative_path").notNull()`
- `sha256`: `text("sha256").notNull()`
- Composite PK: `primaryKey({ columns: [table.runId, table.relativePath] })`

### 4.7 `usage_ledger` & `quota_snapshots`
Enables rolling-window spend/request tracking (`5h`, `7d`, `30d`) across all tasks and MCP instances:
- **`usage_ledger`**:
  - `runId`: `text("run_id").primaryKey()`
  - `taskId`: `text("task_id").notNull()`
  - `sessionId`: `text("session_id").notNull()`
  - `capturedAt`: `integer("captured_at").notNull()` (indexed for `WHERE captured_at >= ?`)
  - `messageCount`: `integer("message_count").notNull()`
  - `inputTokens`: `integer("input_tokens")`
  - `outputTokens`: `integer("output_tokens")`
  - `reasoningTokens`: `integer("reasoning_tokens")`
  - `cacheRead`: `integer("cache_read")`
  - `cacheWrite`: `integer("cache_write")`
  - `reportedCost`: `real("reported_cost")`
  - `complete`: `integer("complete", { mode: "boolean" }).notNull()`
  - `breakdown`: `text("breakdown", { mode: "json" }).$type<UsageBreakdown[]>()`
- **`quota_snapshots`**:
  - `id`: `text("id").primaryKey()` (`"opencode-go"`)
  - `source`: `text("source").notNull()`
  - `fetchedAt`: `text("fetched_at").notNull()`
  - `spendBudget`: `text("spend_budget", { mode: "json" }).$type<SpendBudget>().notNull()`
  - `models`: `text("models", { mode: "json" }).$type<ModelQuota[]>().notNull()`

### 4.8 `workspace_leases` & `task_dispatch_leases`
Cross-process synchronization locks:
- **`workspace_leases`**:
  - `leaseId`: `text("lease_id").primaryKey()`
  - `workspaceRoot`: `text("workspace_root").notNull()` (indexed canonical path)
  - `exclusive`: `integer("exclusive", { mode: "boolean" }).notNull()`
  - `runId`: `text("run_id")`
  - `ownerInstanceId`: `text("owner_instance_id").notNull()`
  - `ownerPid`: `integer("owner_pid").notNull()`
  - `acquiredAt`: `integer("acquired_at").notNull()`
- **`task_dispatch_leases`**:
  - `taskId`: `text("task_id").primaryKey()`
  - `ownerInstanceId`: `text("owner_instance_id").notNull()`
  - `ownerPid`: `integer("owner_pid").notNull()`
  - `acquiredAt`: `integer("acquired_at").notNull()`

---

## 5. Phased Implementation Plan

### Phase 1 — Database Foundation & Auto-Bootstrap (`src/modules/shared/db/`)
1. Update `package.json`: add `drizzle-orm` to `dependencies` and set `"engines": { "node": ">=22.5.0" }`.
2. Create `src/modules/shared/db/schema.ts` defining all Drizzle tables and exported TypeScript row types.
3. Create `src/modules/shared/db/index.ts`:
   - Resolve DB path (`OPENCODE_MCP_HISTORY_DB` > `XDG_STATE_HOME` > `~/.local/state/opencode-mcp/history.sqlite`).
   - Create parent directory with `mode: 0o700`.
   - Open `DatabaseSync`, apply WAL/foreign_keys/busy_timeout PRAGMAs, and run idempotent DDL bootstrap inside a `BEGIN IMMEDIATE` migration block guarded by `PRAGMA user_version`.
   - Register the current process in `mcp_instances` and expose `getDb()`, `getInstanceId()`, `closeDb()`, and `resetDbForTests()`.
4. Add `tests/modules/shared/db.test.ts` with 100% coverage (including `:memory:`, file persistence across re-open, and `user_version` idempotency).

### Phase 2 — Durable Managed Worktrees (`git-workspace.ts` & `workspace-manager.ts`)
1. Persist newly provisioned worktrees into `workspaces` upon `createGitWorkspace()`.
2. Update `describeGitWorkspace()`, `workspaceMetadata()`, `managedWorkspaceTaskIds()`, `reserveManagedWorkspaceCleanup()`, and `removeGitWorkspace()`:
   - When a `workspaceId` is not in the local process `Map`, query `workspaces` (and associated `tasks`) from SQLite to re-hydrate the handle.
   - Use conditional updates (`UPDATE workspaces SET state = 'cleaning' WHERE workspace_id = ? AND state = 'active'`) to prevent concurrent cleanup races across processes.
   - Preserve all existing Git safety checks (`canonicalRepository`, `canonicalWorktree`, `--git-common-dir` match, and `isDirty` check unless `discardChanges = true`).
   - Mark `state = "removed"` and set `removedAt` in SQLite once `git worktree remove` succeeds.
3. Expand `tests/modules/shared/git-workspace.test.ts`, `workspace-manager.test.ts`, and `cleanup_workspace.test.ts` to verify cross-restart worktree cleanup after clearing in-memory maps.

### Phase 3 — Durable Tasks, Runs, Reports & SQLite Baselines (`task-registry.ts`, `run-observer.ts`, `execution-report.ts`)
1. Keep process-local `Map` only for live runtime handles (`controller: AbortController`, `workspaceLease: symbol`), while making SQLite (`tasks` + `task_runs`) the source of truth for `registerTask`, `getTask`, `tasksForServer`, `allTasks`, `acceptTaskRun`, `markTaskCancelled`, `rollbackTaskRun`, and `removeTask`.
2. Replace `dispatchReservations: Set<string>` in `reserveTaskDispatch()` / `releaseTaskDispatch()` with transactional rows in `task_dispatch_leases` (cleaning up stale leases if `ownerPid` is no longer alive via `process.kill(pid, 0)`).
3. Move `WorkspaceSnapshot` file hashes into `workspace_baselines`:
   - Batch-insert `(runId, relativePath, sha256)` in a single synchronous transaction when a run is registered.
   - Reconstruct the `before` map from `workspace_baselines` when `captureReport()` runs, then `DELETE FROM workspace_baselines WHERE run_id = ?` once the report is saved.
4. Persist observer state transitions (`executionState`, `report`, `usage`, `result`, `reportReady`, `finalizationError`) with fencing generation checks (`observer_generation`) in `run-observer.ts`, `get_task_status.ts`, and `get_task_result.ts`.
5. Expand `tests/modules/shared/task-registry.test.ts` and `run-observer.test.ts` to verify that historical runs, reports, and `cancelled` status survive memory resets.

### Phase 4 — Usage Ledger & Quota Snapshot Persistence (`usage-limits.ts`, `execution-usage.ts`, `list_agents.ts`)
1. Update `usage-limits.ts` to store and read `UsageLimits` in `quota_snapshots` (keeping JSON cache fallback if DB is disabled/read-only).
2. When `run-observer.ts` finalizes a run with a valid `ExecutionUsageReport`, upsert the run's token and cost metrics into `usage_ledger`.
3. Add a query helper `getRollingUsageSummary(windowMs)` that aggregates `usage_ledger` over the last 5 hours (`5 * 3600 * 1000`) and 7 days, returning total `reported_cost`, request/message counts, and per-model breakdown.
4. Expose `local_usage` in `opencode_list_agents` output alongside `quota_snapshot` so orchestrator agents can see actual recent consumption alongside static tier limits.
5. Update `tests/modules/shared/usage-limits.test.ts` and `tests/modules/tools/list_agents.test.ts`.

### Phase 5 — Cross-Process Workspace Leases & Retention (`execution-report.ts`)
1. Upgrade `reserveWorkspace(directory, exclusive)` and `releaseWorkspace(token)` in `execution-report.ts`:
   - Inside a `BEGIN IMMEDIATE` transaction on `workspace_leases`, inspect existing leases.
   - If a conflicting lease belongs to a dead process (`ownerPid !== process.pid` and `process.kill(ownerPid, 0)` throws `ESRCH`) and its run is not awaiting uncertain recovery, reap the dead lease.
   - Enforce the path-overlap rule (`a === b || a.startsWith(b + sep) || b.startsWith(a + sep)`) across all live processes.
   - Insert the new `workspace_leases` row and map it to the local `symbol` token.
2. Add bounded retention helper for finalized terminal runs older than configurable TTL while never pruning active, `uncertain`, or dirty-worktree records.
3. Verify with multi-instance contention tests in `tests/modules/shared/execution-report.test.ts`.

---

## 6. Verification & Orchestration Strategy for the Build Session

- **Delegation via Worktrees**: During the implementation session, independent phases/modules can be delegated to OpenCode agents using `opencode_start_task` with `workspace_mode: "worktree"` and `free` / `high-volume` models from `opencode-go`, then merged and verified by the orchestrator.
- **Test Isolation**: Set `OPENCODE_MCP_HISTORY_DB=":memory:"` by default in Vitest setup (and use temporary file DBs specifically for persistence/re-hydration/multi-process tests).
- **Mandatory Quality Gates**:
  - `pnpm build` (`tsc` typecheck + clean build)
  - `pnpm lint` (`biome check .`)
  - `pnpm test:coverage` (**100% threshold** on lines, branches, functions, and statements across `src/**/*.ts`)
  - `pnpm smoke --message-id-only`


# SQLite Persistence and Multi-Instance Coordination Plan

**Status:** Proposed design; no SQLite persistence implementation has been applied yet.

This plan makes task history and lifecycle state durable across MCP restarts while allowing several `opencode-mcp` processes on the same machine to use one SQLite file safely. The database is the coordination point for task admission, dispatch reservations, workspace leases, recovery, and retention—not just a backup of the current in-memory maps.

## Quick path

1. Keep task/session history separate from live process handles.
2. Make writes and capacity reservations transactional across every MCP process using the file.
3. Reconcile persisted runs with their OpenCode sessions before resuming observers or freeing resources.
4. Retain completed results under a bounded policy; never expire uncertain runs or dirty worktrees automatically.
5. Validate the database with multi-process race tests and abrupt-process-death tests.

## Goals and operating assumptions

### Goals

- Preserve tasks, runs, results, reports, usage snapshots, and managed worktree ownership across MCP process restarts.
- Allow several MCP instances to share one database and enforce shared task/workspace limits without duplicate dispatch or finalization.
- Reconcile OpenCode sessions and surviving child processes on startup rather than blindly resending prompts.
- Retain enough model and usage information to assess whether delegation is saving frontier-model context and cost.
- Bound stored history and database growth without deleting active work or unreviewed workspace changes.

### Assumptions and non-goals

- Multiple MCP instances run as the **same OS user on the same host** and access the same local filesystem path.
- All instances use the same database-wide limit and retention configuration. Startup should fail clearly if active instances advertise conflicting policy versions.
- A SQLite file on NFS, SMB, cloud-sync, or a filesystem shared across hosts is out of scope. If multi-host coordination becomes necessary, move to a client/server database.
- SQLite durability does not itself make an OpenCode child process reattachable. The server endpoint and session must be verified independently.
- This plan does not add encryption-at-rest or persist complete OpenCode conversations. The database is protected by local filesystem permissions.

## Current architecture and persistence gaps

| Area | Current behavior | Design implication |
|---|---|---|
| Tasks and dispatch reservations | `task-registry.ts` stores tasks in a `Map` and active task dispatch reservations in a `Set`. | Persist task and run state; replace process-local reservations with transactional leases. |
| Runs | A task can have multiple `TaskRunRecord`s, one for each initial or continued prompt. Each run has a local run ID and an OpenCode message ID. Dispatch can be `dispatching`, `accepted`, `uncertain`, or `rejected`. | Runs must be first-class rows. Keep dispatch, execution, and finalization state distinct. |
| Prompt delivery | `sendPromptAndClassify()` distinguishes definite rejection from ambiguous acknowledgement. | Persist the run and message ID before calling OpenCode. Never blindly retry an ambiguous send. |
| OpenCode servers | `start_server.ts` generates a server ID and registers a URL, working directory, policy, and an in-memory `close` callback. | Persist server identity and metadata, but not callbacks. A saved URL is not proof that a server is alive. |
| Workspaces | `workspace-manager.ts` and `git-workspace.ts` keep ownership handles, related task/session IDs, and cleanup state in process-local maps. | Persist canonical paths and Git identity; reconstruct handles and validate ownership on startup. |
| Run finalization | `run-observer.ts` polls OpenCode, captures reports and usage, and caches final result text. | Persist final results and report-ready state before considering a run finalized. Coordinate observers across processes. |
| Verification baseline | `WorkspaceSnapshot` is an in-memory map of paths to hashes. Inventory is bounded to 20,000 files and 32 MiB. | Keep a baseline only while it is required to recover an active run's report; remove it after durable finalization. |
| Usage | `ExecutionUsageReport` tracks direct assistant-message metrics, model breakdowns, and completeness. It excludes descendant/subagent sessions; reported cost has no verified currency. | Store completeness and scope metadata. Do not label reported cost as invoiced cost or total delegated spend. |
| Existing filesystem cache | `usage-limits.ts` uses `OPENCODE_MCP_CACHE_DIR` / `XDG_CACHE_HOME` for a refreshable cache. | History is durable state, not cache; give it a separate path and override. |

Relevant source: `src/modules/shared/{task-registry,server-registry,workspace-manager,git-workspace,run-observer,execution-report,execution-usage,prompt-dispatch}.ts` and `src/modules/tools/{start_task,continue_task,start_server,cleanup_workspace}.ts`.

## Database location and driver

### Location

Use an explicit `OPENCODE_MCP_HISTORY_DB` absolute-path override. Default to:

```text
$XDG_STATE_HOME/opencode-mcp/history.sqlite
```

When `XDG_STATE_HOME` is unset, use `~/.local/state/opencode-mcp/history.sqlite`. Create the parent directory with owner-only permissions where supported, and create the database with owner-only read/write permissions. Resolve the path once, canonicalize it, and log the resolved path on startup (to stderr, never stdout).

The existing `~/.config/opencode` proposal remains usable through the explicit override. Keeping the default under an `opencode-mcp` state directory avoids mixing MCP runtime history with OpenCode configuration and avoids treating durable history as disposable cache.

Every MCP process must resolve to the same canonical database path. WAL sidecar files (`-wal` and `-shm`) live beside the database and inherit the directory's access boundary.

### Driver compatibility gate

The package currently declares Node.js `>=18`. Node's built-in `node:sqlite` was introduced in Node 22.5; it is no longer behind the experimental flag in Node 22.13 but remains experimental on the Node 22 line, and is a release candidate beginning with Node 24.15. Do not adopt it while claiming Node 18 support without an explicit runtime-floor decision.

Select a maintained external SQLite driver if the Node 18 runtime contract is retained. `better-sqlite3` is a candidate, not an assumed compatibility guarantee: verify installation and execution on the project's declared runtime and CI versions, including the native addon build/prebuilt-binary path. If the driver cannot be supported on Node 18, either choose another driver or explicitly revise the supported Node floor before implementation.

For any synchronous driver, keep database transactions short and synchronous. Never hold a transaction across HTTP calls, process spawning, filesystem walks, or other `await` operations. The driver’s SQLite transaction helper must not wrap an async function.

References: [Node.js SQLite API](https://nodejs.org/api/sqlite.html), [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), and [better-sqlite3 performance notes](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md).

## Proposed schema

Use normalized columns for IDs, state, timestamps, model identity, and fields used for admission/retention queries. Keep versioned JSON payloads for nested reports, verification definitions/results, and usage snapshots; they are retrieved as run results, not queried field-by-field by current tools.

### Core tables

| Table | Key fields | Purpose |
|---|---|---|
| `mcp_instances` | `instance_id` PK, `pid`, `process_started_at`, `heartbeat_at`, `stopped_at`, `policy_version`, `policy_hash` | Identifies each MCP process sharing the file. PID alone is insufficient because the OS can reuse it; pair it with process start identity and a heartbeat. |
| `servers` | `server_id` PK, `owner_instance_id`, `base_url`, `directory`, `permission_policy`, `started_at`, `stopped_at`, `last_verified_at`, optional process identity | Retains server identity and connection metadata for task lookups and recovery. Do not serialize the `close` callback. Verify the endpoint/process before reuse. |
| `workspaces` | `workspace_id` PK, `server_id`, `repository_directory`, `source_directory`, `worktree_directory`, `execution_directory`, `base_commit`, `source_dirty`, `mode`, `state`, `created_at`, `removed_at` | Preserves worktree ownership independently of task result retention. Keep removed workspace rows long enough to explain historical task metadata. |
| `tasks` | `task_id` PK, `server_id`, `session_id`, `directory`, nullable `workspace_id`, `current_run_id`, immutable `created_at`, `updated_at`, optional materialized `current_status` | Represents the long-lived OpenCode session addressed by task tools. `current_status` is a projection; the current run remains the source of truth. |
| `task_runs` | `run_id` PK, `task_id` FK, unique `message_id`, `agent_name`, requested provider/model IDs, `dispatch_state`, `execution_state`, `finalization_state`, lifecycle timestamps, result/error, expected changes/checks/report/usage JSON | Stores each start/continue prompt, its acknowledgement and execution lifecycle, and the result returned by `get_task_result`. |
| `workspace_leases` | `lease_id` PK, `workspace_id`, `run_id`, `owner_instance_id`, canonical `root_path`, access mode, `acquired_at`, `heartbeat_at`, `expires_at`, `generation` | Replaces process-local path-overlap reservations so two instances cannot run conflicting checks or clean a workspace in use. |
| `task_dispatch_leases` | `task_id` PK, `owner_instance_id`, `run_id`, `acquired_at`, `heartbeat_at`, `expires_at`, `generation` | Replaces the in-memory `dispatchReservations` set and prevents concurrent continuations for one task across processes. |
| `run_recovery_state` | `run_id` PK/FK, compressed baseline snapshot, check-finalization state, `updated_at` | Temporary recovery payload for runs whose baseline/report is not finalized. Delete after the report and result are committed. |

Add `run_usage_by_model` if model-level usage summaries need efficient SQL reporting. Store one row per run/provider/model with message count and each metric’s value, completeness flag, and missing-message count. Keep the original usage JSON in `task_runs` as the full immutable snapshot.

Add an append-only `run_events` table if operators need a transition timeline. Record meaningful transitions (dispatch started/accepted/uncertain/rejected, cancellation, terminal state, finalization, cleanup), not every one-second observer poll.

### Important field semantics

- `task_runs.dispatch_state`: `dispatching | accepted | uncertain | rejected`.
- `task_runs.execution_state`: `pending | running | completed | failed | empty | cancelled | error | unavailable` (keep aligned with the MCP status contract).
- `task_runs.finalization_state`: `pending | running | complete | unavailable`.
- Persist `started_at`, `dispatch_acknowledged_at`, `terminal_at`, `finalized_at`, and `cancel_requested_at` separately. A completed execution may still be finalizing its report.
- Preserve both requested `provider_id/model_id` and observed usage breakdown. The requested model can differ from actual message usage.
- `message_id` must retain OpenCode's `msg_` prefix and be unique. It is the correlation key for inspecting a session after an uncertain acknowledgement.
- `created_at` on `tasks` is the first task creation time. Each continuation gets its own `task_runs.started_at`; do not copy the current in-memory field that is overwritten when a new run is accepted.
- Do not store live JavaScript values such as `AbortController`, `Symbol` leases, `Map` snapshots, SDK clients, or callback functions as if they were durable state.

### Prompt and result privacy

Do not persist full prompt text by default. The prompt is already represented in the OpenCode session, while task/run IDs and `message_id` are enough to correlate it when that server is reachable. Optionally store prompt byte length and a hash for diagnostics/deduplication. Full prompt retention should be an explicit opt-in because prompts may contain source code, credentials, or private context.

Persist the final result text and serialized report/usage snapshot because those are the MCP result surface and must remain retrievable even if the OpenCode server later becomes unavailable. Apply the history retention policy to these payloads.

## Multi-instance coordination and transaction rules

SQLite WAL permits concurrent readers with a single writer. It does not provide multiple simultaneous writers. Use WAL for reader/writer coexistence, foreign keys on every connection, a bounded busy timeout, and short write transactions. Choose `synchronous=FULL` for the durability boundary around accepted dispatch records unless benchmarks demonstrate a material cost that justifies a documented weaker guarantee. Monitor/checkpoint WAL growth; long-running readers can prevent checkpoint progress.

### Atomic task admission and dispatch

For `start_task` and `continue_task`:

1. Begin an immediate write transaction.
2. Check global/per-server active-run limits against persisted nonterminal runs, including `dispatching`, `accepted`, and `uncertain` runs.
3. Acquire the task dispatch lease and any workspace lease. For overlapping filesystem paths, compare canonical paths while holding the write reservation; preserve the current shared/exclusive overlap semantics.
4. Insert/update task and run rows with a new run ID and `message_id`; persist the exact requested model/agent and verification definitions. Commit the intent **before** the external OpenCode call.
5. Send the prompt outside the transaction.
6. In a second short transaction, record `accepted`, `rejected`, or `uncertain` and release only the dispatch-operation lease. An uncertain run continues to consume an active slot until reconciled.

Use unique constraints and conditional updates as the final defense against races; do not rely only on `SELECT` followed by an unguarded insert. On `SQLITE_BUSY`, retry a small bounded number of times with jitter, then return a clear storage-busy error rather than silently dropping work.

### Observer ownership and leases

Only one MCP instance may observe/finalize a given run at a time. Store observer ownership, lease expiration, and a monotonically increasing generation/fencing token on the run (or a dedicated run lease row). Every finalization write must verify the owner and generation so a late former owner cannot overwrite a newer recovery attempt.

Heartbeat instance and active leases. Lease expiry only makes a resource eligible for reconciliation; it does **not** prove the OpenCode agent or a check process stopped. Before releasing capacity or starting another observer, verify the owner process and reconcile the OpenCode session. Keep uncertain workspace leases until termination is confirmed or an explicit recovery decision is made.

For cleanup, transition the workspace to `cleaning` with a conditional database update, commit, perform Git operations outside the transaction, then mark it `removed`. If the process dies during cleanup, startup validates the repository/worktree relationship before completing or releasing the cleanup state. Never automatically force-remove dirty worktrees.

### Server and instance identity

On every process start, create a fresh `instance_id`, register its PID/start identity, and periodically update its heartbeat. Mark it stopped on graceful shutdown. After a hard kill, treat a stale heartbeat as a reconciliation signal, not proof that child processes are gone. Probe the recorded OpenCode endpoint and verify process identity where available; PID reuse must not attach to an unrelated process.

Because active instances share one file, enforce one database-wide policy version for limits and retention. Either store the effective policy in a singleton settings row or reject startup when live instances advertise incompatible limit values. Do not let each process enforce an independent “global” task cap.

## Startup recovery

1. Open the canonical database path, enable SQLite connection settings, and apply migrations under a transaction before registering MCP tools.
2. Register the new `mcp_instance` and inspect stale instances/leases.
3. Validate saved server endpoints. Reconstruct SDK clients and permission responders only for endpoints that are reachable and match saved identity/policy.
4. Load unfinished runs and reconcile by `server_id`, `session_id`, and `message_id`:
   - If OpenCode confirms the message/turn, update the persisted execution state and resume a single leased observer.
   - If dispatch acknowledgement was uncertain, do not resend automatically. Keep the run uncertain until the existing turn is found or a safe terminal decision is made.
   - If the server cannot be reached, report the run as unavailable/orphaned while retaining workspace ownership; do not claim completion or release its slot solely because an MCP process disappeared.
5. Resume report finalization only from durable recovery state. Persist check state before starting each check. If a check's side effects/termination cannot be determined after a crash, mark verification unavailable rather than rerunning it blindly.
6. Recover workspaces and cleanup transitions by validating Git metadata and path ownership. Dirty worktrees remain intact for explicit inspection/cleanup.
7. Start the retention worker only after recovery has classified active and uncertain rows.

The first release with SQLite cannot recover tasks created by the previous in-memory-only version after that old process exits. Drain existing work before upgrading; durable recovery applies to tasks created after the SQLite version starts.

## Retention and storage limits

Retention is based on finalized state, not on task creation time alone.

- Never purge `dispatching`, `accepted`, `uncertain`, running, finalizing, or unreconciled runs.
- Keep complete terminal result/report/usage payloads for a configurable retention window and maximum history size; apply whichever bound is reached first.
- Optionally retain compact task/run summaries longer than full result/report payloads.
- Preserve workspace ownership rows while a worktree exists. Do not let task-history pruning delete a dirty worktree or its ownership record.
- Remove `run_recovery_state` after finalization is durably complete.
- Run pruning in small transactions. Expose database size/WAL size and pruning counts in diagnostics.
- If disk/database limits are reached, reject new work with an actionable error; never delete active or uncertain runs as an emergency space-reclamation shortcut.

The exact TTL, maximum task/run counts, maximum DB size, and maximum active runs remain policy values to agree on before implementation. Keep them database-wide so all instances enforce the same limits.

## Implementation sequence

### Phase 1 — storage foundation

- Add a dedicated history database path/config resolver; do not reuse the usage-limits cache path.
- Select and verify a SQLite driver against the supported Node matrix.
- Add a small SQLite module for connection setup, migrations, transactions, and shutdown.
- Use `PRAGMA user_version` for ordered schema migrations. Make simultaneous startup safe by serializing migrations.
- Set WAL, foreign keys, busy timeout, and the chosen durability setting on every connection as appropriate.

### Phase 2 — repositories and durable lifecycle writes

- Add repositories for instances, servers, workspaces, tasks, runs, and usage.
- Make DB rows the source of truth; build the current in-memory maps as caches/projections, not independent authorities.
- Update start/continue dispatch so an intent row with a stable `message_id` is committed before sending.
- Persist state changes, cancellation, final result, report, usage, and workspace state transactionally.
- Add requested agent/model fields to run persistence; preserve usage completeness and observed model breakdown.

### Phase 3 — cross-process leases and limits

- Replace `dispatchReservations` with task dispatch leases.
- Replace in-memory workspace reservations with persisted workspace leases that preserve path-overlap rules.
- Add observer/finalizer ownership with fencing generations.
- Enforce global active-task and per-server caps in the same transaction that inserts the dispatching run.
- Add consistent capacity errors and bounded `SQLITE_BUSY` handling.

### Phase 4 — recovery

- Persist active run baseline/recovery state and progress of finalization/checks.
- Add startup instance/server/session/workspace reconciliation.
- Ensure uncertain prompt acknowledgements are inspected, not retried blindly.
- Recover or quarantine stale leases without declaring child processes dead based only on elapsed time.

### Phase 5 — retention and operations

- Implement bounded pruning and compact-history rules after recovery.
- Keep dirty/uncertain workspaces protected from automatic deletion.
- Add structured database/lease/recovery diagnostics keyed by instance, task, run, server, and workspace IDs.
- Document backup/restore behavior and the local-filesystem requirement.

## Verification plan and acceptance criteria

### Repository and migration tests

- Fresh database creates all tables, indexes, constraints, and expected PRAGMAs.
- Reopening the database preserves rows and does not reapply migrations incorrectly.
- Two simultaneous process startups serialize migrations and both initialize safely.
- Foreign keys and unique `message_id`/run constraints reject invalid or duplicate rows.

### Multi-process coordination tests

- Launch several child processes against one temp database and race task admissions. The configured global cap is never exceeded.
- Race two continuations for the same task; exactly one acquires the dispatch lease.
- Race overlapping workspace read/write leases and cleanup; results match existing conflict semantics and no writer is released early.
- Race observers for one run; only one owner finalizes it and a stale owner with an old fencing generation cannot overwrite the result.
- Lock contention either succeeds within the bounded timeout or returns an explicit storage-busy result; it never drops an accepted task.

### Crash and recovery tests

Kill a separate MCP process abruptly at each durable boundary: before dispatch, after persisting `dispatching`, after OpenCode accepts but before acknowledgement persistence, after terminal execution but before report finalization, during check execution, and during workspace cleanup. On restart, verify:

- task/run IDs and results are recoverable;
- no uncertain prompt is sent a second time;
- server/session state is reattached only after identity validation;
- capacity and workspace leases are not released while work may still be active;
- interrupted checks are not blindly repeated;
- dirty worktrees remain present and owned.

### Retention and load tests

- Terminal history is pruned by the agreed TTL/size policy, while active/uncertain rows are retained.
- Removing task history never removes a live or dirty workspace.
- Concurrent starts and polling keep MCP tool responses available under the configured cap.
- WAL/database growth is bounded under sustained writes and checkpoint behavior is observable.

## Risks and decisions required before implementation

| Decision | Recommended constraint |
|---|---|
| SQLite path | `OPENCODE_MCP_HISTORY_DB`, default under XDG state; same canonical path for every instance. |
| Filesystem scope | Same host/local filesystem only; not a synced/network-mounted shared file. |
| SQLite driver | Keep Node `>=18` unless explicitly changed; select a driver only after CI install/runtime verification. |
| Global active limit | One database-wide value, enforced transactionally across instances. Exact value remains configurable. |
| Lease expiry | Expiry triggers reconciliation; it does not by itself prove execution stopped. |
| Prompt retention | Full prompt omitted by default; retain session/message IDs and optional hash/length. |
| Result retention | Configurable TTL plus maximum history/DB size; active and uncertain runs are protected. |
| Worktree cleanup | Never force-remove dirty worktrees automatically. |
| Usage interpretation | Store incomplete metrics and `reported_cost` labels; do not claim descendant usage or invoice totals. |

## Relevant implementation files

- `src/modules/shared/task-registry.ts` — current in-memory task/run state and dispatch reservation.
- `src/modules/shared/server-registry.ts` — current in-memory OpenCode server registry.
- `src/modules/shared/workspace-manager.ts` and `git-workspace.ts` — worktree ownership and safe cleanup.
- `src/modules/shared/run-observer.ts` — lifecycle observation, result caching, report/usage finalization.
- `src/modules/shared/execution-report.ts` — workspace baseline, check execution, and bounded output.
- `src/modules/shared/execution-usage.ts` — usage metrics, scope, and completeness semantics.
- `src/modules/tools/start_task.ts` and `continue_task.ts` — prompt dispatch entry points requiring durable intent writes.
- `src/modules/tools/start_server.ts` and `stop_server.ts` — server registration and shutdown lifecycle.

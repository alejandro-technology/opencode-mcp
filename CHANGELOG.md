# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before `1.2.0` predate this file and are not documented here.

## Unreleased

## [1.3.0] — 2026-10-19

### Added

- Caller-provided expected workspace changes and bounded executable checks, with additive per-run `workspace_delta` reports and verification states.
- Workspace-wide overlapping-directory leases, report-aware waits, and an independent lifecycle observer for accepted runs.
- Prompt dispatch now distinguishes definite HTTP 4xx rejection from ambiguous ACK failures. Ambiguous runs remain tracked with their writer lease held and return `dispatch_uncertain`; definite rejection rolls back only the provisional run.
- Caller message IDs use OpenCode's required `msg_` namespace; the real smoke includes a non-billable bare-UUID runtime probe.
- Bounded filesystem inventory, check output, and direct `shell: false` execution; report diagnostics disclose incomplete evidence and shared-workspace attribution uncertainty.
- Historical `run_id` status/result retrieval and cached final text/progress/report; tool getters do not execute checks again.
- Opt-in real OpenCode stdio smoke command (`pnpm smoke`) using only the exact `openai/gpt-6-luna` model, including directory-scoped permission handling and independent managed worktrees.
- Each accepted prompt has an additive `run_id` and run-history record. Explicit user-message IDs scope status, progress, and results to the active prompt; earlier assistant turns cannot appear as a pending continuation's output.
- Continuation dispatches are reserved per task, cancellation state is recorded only after an accepted abort, and accepted continuations clear prior cancellation state.
- Status and wait share terminal-state rules; `empty` and `cancelled` now finish long polls.
- SDK HTTP requests use a 30-second abort deadline; long-polling bounds each status read by the remaining total wait deadline.
- Server/task records optionally retain the canonical server working directory.
- Status, wait, and result payloads report direct assistant INFO usage with run/session snapshots, provider/model breakdowns, completeness metadata, and immutable per-run historical snapshots; missing metrics remain unknown and cost currency is unspecified.
- Optional task directories and managed detached Git worktrees bind SDK requests and per-session permission responders to the selected project. Worktree IDs/metadata appear in task history, and `opencode_cleanup_workspace` performs explicit serialized cleanup while preserving cached reports and usage.

### Fixed

- SDK response-level errors are surfaced for prompt dispatch, abort, status/message reads, and permission responses, including HTTP failures returned without throwing.
- Permission responder diagnostics go to stderr rather than MCP stdio.
- `opencode_wait_for_task` progress enrichment now shares the absolute wait deadline; a slow enrichment is aborted and returns the last observed task status/progress rather than extending the call.

## [1.2.0] — 2026-08-28

Delegated tasks could hang forever, or report `completed` after doing nothing.
Both are fixed, and the result payload now carries evidence of what a task
actually did. See `docs/incident-2026-08-21-silent-noop-tasks.md` for the full
report this release closes out.

### Behavior changes callers must handle

- `opencode_get_task_status` and `opencode_get_task_result` can now return two
  new statuses: **`empty`** and **`cancelled`**. Both were previously reported
  as `completed`. Code that switches exhaustively on task status needs a branch
  for them; code that only special-cases `completed` will now correctly stop
  treating a no-op or an aborted task as a success.
- `opencode_get_task_result` now includes a `progress` object. Previously it
  returned only `status` and `result`.
- `opencode_start_server` now reports its permission posture under
  `permissions` (`{ external_directory, auto_approved }`).

### Added

- **Permission responder for headless servers.** A headless `opencode serve`
  has no interactive approver, so any permission resolved to `ask` blocked the
  agent forever — the session stayed genuinely busy and the task neither
  completed nor failed. `opencode_start_server` now passes a permission config
  to the OpenCode server *and* subscribes to its event stream to answer every
  request.
- **`OPENCODE_MCP_EXTERNAL_DIR`** selects how the delegated agent may touch
  paths outside the directory the server was launched in. Precedence: env var >
  `OPENCODE_MCP_EXTERNAL_DIR=<policy>` CLI arg > default.
  - `read-only` (default) — reads outside the cwd are approved, writes rejected.
  - `allow` — no boundary.
  - `deny` — nothing outside the cwd is reachable.

  Inside the cwd everything is auto-approved; the caller already owns that
  directory. The config is deep-merged per permission key, so existing
  `read` / `edit` / `bash` deny globs (secrets, keys, `.env`) survive untouched.
- **Side-effect evidence in `TaskProgress`**: `mutating_tool_calls` and
  `files_touched`, collected across every assistant turn in the session.
  `completed` with an empty `files_touched` on a task whose whole purpose was
  writing files is the signal that catches a silent no-op.
- **Per-model quota annotations.** `opencode_list_agents` now returns each model
  as `{ id, quota }` with a `per_5h` estimate and a tier (`high-volume`,
  `balanced`, `scarce`), scraped from the OpenCode Go docs and cached on disk
  for 24h. A sibling `models.quota_snapshot` distinguishes "this model has no
  quota row" from "we never got the table". Overridable with
  `OPENCODE_MCP_CACHE_DIR` and `OPENCODE_MCP_LIMITS_TTL_MS`; a failed fetch
  falls back to the stale snapshot, so startup never depends on the network.

### Fixed

- **Tasks no longer hang on a permission prompt.** Previously, any task reading
  or writing a path outside the server cwd wedged indefinitely with no way for a
  caller to tell "working" from "stuck".
- **`completed` is now a work check, not a timestamp check.** An assistant turn
  that ended with no text and no tool calls reports `empty` instead of
  `completed` with an empty result. A completed timestamp says the turn ended,
  not that it did anything.
- **Evidence is collected across the whole session, not just the last turn.** An
  agent's edits land in earlier turns while the final turn is usually just
  "DONE", so reading evidence off the last message alone reported
  `files_touched: []` for a task that had rewritten the workspace.
- **Cancelled tasks report `cancelled`.** `opencode_cancel_task` now records the
  cancellation, and status derivation checks it first. An aborted session keeps
  its completed timestamp, so a deliberately killed task was previously
  indistinguishable from one that finished on its own. A cancelled task still
  returns whatever it produced before the abort, `files_touched` included.
- **The stall guard covers the empty-turn case.** `PENDING_STALL_MS` was only
  reachable when no assistant message existed at all; once any message existed —
  including an empty or aborted one — the guard was bypassed permanently.

### Notes for contributors

- The generated `@opencode-ai/sdk` types lag the running binary. Verified
  against opencode `1.18.18` with SDK `1.17.20`: the live permission event is
  `permission.asked` (the SDK declares only `permission.updated`), its kind
  arrives as `properties.permission` (the SDK says `type`), and the call id is
  nested under `properties.tool.callID` (the SDK puts it at the top level).
  Verify wire shapes against a live server before trusting a generated type — a
  mismatch here fails silently, because a permission that is never answered just
  hangs.
- Two bugs in this release passed a green unit suite and were caught only by
  running against a live server. Mocks reproduce the contract you believe in,
  not the one the system implements.

### Not addressed

- **F3** from the incident report: there is still no staleness signal on the
  `running` path. `buildProgress` reports `current_tool` and
  `current_tool_status` but no timing, so a caller has no field to compare
  across polls to tell a slow task from a wedged one.

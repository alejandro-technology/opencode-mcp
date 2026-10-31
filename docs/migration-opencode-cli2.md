# Migration report: OpenCode CLI 2

**Status:** implemented and locally verified; not released to npm. This migration replaces the legacy OpenCode API adapter while preserving asynchronous delegation, per-run history and usage, execution reports, and managed worktrees.

## Verified baseline

| Item | Value |
| --- | --- |
| Verification date | 2026-10-31 |
| Git baseline | `e142d786589e163ed679b038f981a612699c0afc` |
| Delivery branch | `feat/opencode-cli2-migration` |
| Installed OpenCode CLI | `2.2.1` |
| Official client | `@opencode/client` `2.2.5` (dependency range `^2.2.5`) |
| Local Node.js | `22.22.3` |
| Minimum Node.js | `22.18` for runtime and development |
| Paid-smoke model | Exact discovered ID `openai/gpt-6-luna` |
| Package version | Unchanged at `1.3.1`; migration documented under `Unreleased` |

The startup guard accepts CLI versions `>=2.2 <3`, but the real verification in this report applies specifically to CLI `2.2.1` and client `2.2.5`. Passing a version guard is not evidence of compatibility with every admitted version. The CI matrix remains Node.js 22 and 24; the local results below are from Node.js `22.22.3`, not a claim that both CI jobs were run locally.

## Why a migration was necessary

The previous adapter used `@opencode-ai/sdk` and the OpenCode 1.x API. Two independent changes prevented it from driving the installed CLI:

1. The legacy launcher expected the banner `opencode server listening`; CLI `2.2.1` prints `server listening on`. A healthy process could therefore time out during startup.
2. The legacy routes and message/event contracts no longer matched CLI 2. A live legacy `POST /session` returned HTTP 405, while routes such as `/global/health` could return the web application's HTML rather than API health data.

Updating the old package to `@opencode-ai/sdk` `1.19.5` was not a solution: it remained the legacy client. Its `/v2` export also did not establish CLI 2 compatibility. The matching official package was `@opencode/client` `2.2.5`.

Consequently, neither a changed banner matcher nor a successful TCP connection was sufficient. The migration required a new client, authenticated readiness checks, and adaptation of the task lifecycle and wire formats.

## Implementation decisions

| Area | Decision and preserved behavior |
| --- | --- |
| Server ownership and readiness | Own the launcher and CLI child; pass a supplied or generated private Basic-auth password. Verify server version and PID, then a protected location endpoint. Do not accept a responding port or SPA page as readiness. Resolve the launcher as `.ts` in source mode and `.js` in build output. |
| Client and locations | Construct authenticated clients with `OpenCode.make`. Send explicit project locations for session creation and discovery, including nested directories and managed worktrees. |
| Asynchronous dispatch | Use CLI 2 `session.prompt` with a caller-generated message ID and retain the inbox acknowledgement. Return task/run IDs before execution completes. Keep uncertain dispatch tracked rather than automatically sending a duplicate prompt. |
| Messages and results | Read ascending message pages through `cursor.next`. Correlate assistants with the preceding user message because CLI 2 does not provide v1 assistant `parentID`. Normalize content, errors, model and usage; reasoning is not delivered final text. |
| Progress and evidence | Recognize CLI 2 tools such as `shell`, `subagent`, and `patch`, and paths such as `input.path`. Aggregate tool activity across the current run while keeping independent workspace-delta evidence. |
| Continuation selection | Apply primary-agent/model overrides using session selection APIs, not prompt mentions. Preserve the prior model variant and restore selection after confirmed terminal execution or definite pre-dispatch rejection. Uncertain dispatch retains protection; restoration failures remain explicit. |
| Cancellation | Handle active interruption and queued inbox cancellation. An interrupt ACK confirms acceptance, not writer cleanup. Wait until the session is absent from `session.active()` before cancellation finalization, selection restoration, or writer-lease release. Retain protection if cancellation cannot be confirmed. |
| Permissions | Add only the session's scoped `external_directory` rule, not a catch-all allow that replaces other tool denies. Reconcile owned pending requests after event-stream connection and reconnection. Correlate external requests to source tool parts; approve reads once and reject writes or unknown operations under the default policy. |
| Deadlines | Preserve already-aborted signals and bounded request behavior instead of losing cancellation when a request starts. |
| History and usage | Retain finalized per-run result/report/usage snapshots, including after worktree cleanup. Preserve unknown metrics rather than inventing zeros. Reported cost remains OpenCode-provided data, not an invoice total. |

### Compatibility changes callers should know

- Runtime now requires Node.js `22.18+`; the official client uses `Promise.withResolvers`. OpenCode 1.x is no longer a supported target.
- Tool names and asynchronous task/run/workspace identifiers remain available.
- Discovery adds canonical `agents.all`. Each agent's `name` is its machine ID; `display_name` is its label. The retained `native` / `custom` buckets use `classification: "builtin_ids"`, a nominal ID classification, not provenance that CLI 2 does not expose.
- `models.defaults` reflects the CLI's selected default rather than inventing a default for every provider. Provider model entries remain `{ id, quota }` objects.
- `--contract-only` is the canonical non-billable smoke mode. `--message-id-only` remains an alias, but no longer means the historical CLI 1 bare-UUID probe.

## Verification evidence

### Static checks and unit tests

The installed local tools passed these checks against the migrated tree:

```bash
./node_modules/.bin/biome check .
./node_modules/.bin/tsc -p tsconfig.smoke.json
rm -rf build && ./node_modules/.bin/tsc -p tsconfig.json && chmod +x build/src/index.js
./node_modules/.bin/vitest run --coverage
```

**Result:** lint, both typechecks/build, and all **450 tests across 33 suites** passed. Coverage thresholds and exclusions were not changed; both new launcher modules are covered.

| Metric | Covered / total | Coverage |
| --- | --- | --- |
| Statements | 1910 / 1910 | 100% |
| Branches | 1473 / 1473 | 100% |
| Functions | 335 / 335 | 100% |
| Lines | 1686 / 1686 | 100% |

The smoke harness now has its own `tsconfig.smoke.json` and `pnpm check:smoke` gate. CI and `pnpm smoke` run this check because scripts are outside the source build scope.

**Package-manager limitation during verification:** pnpm 11 refused the newly published `@opencode/client`, `@opencode/protocol`, and `@opencode/schema` `2.2.5` packages under its default minimum-release-age protection. The checks above used already-installed local tools without another install. No global policy override or dependency-age exception was added. These are passing tool-level results, not a claim that the policy-blocked pnpm invocations passed. A fresh install must wait for the threshold or follow the operator's dependency-review policy.

### Real OpenCode checks

Independent verification using `openai/gpt-6-luna` subagents confirmed:

| Scenario | Result |
| --- | --- |
| Source-mode launcher | Native TypeScript import on Node.js `22.22.3`; authenticated SDK server-info/location calls succeeded against CLI `2.2.1`, and the listener closed on shutdown. This checked the launcher, not an interactive MCP Inspector session. |
| Non-billable contract smoke | `node scripts/smoke.ts --contract-only` passed; invalid model and agent returned `unknown_model` and `unknown_agent`. |
| Full real smoke | `OPENCODE_MCP_SMOKE_MODEL=openai/gpt-6-luna node scripts/smoke.ts` exited **0**. |
| Task execution and reports | Expected file contents observed; caller check executed once; repeated finalized results were identical. |
| Continuation and history | Continuation completed; earlier results and finalized usage snapshots remained available. The deliberate no-change/failed-verification scenario was correctly reported. |
| Cancellation | Cancellation settled without timeout; the late-write probe remained absent both before and after settlement. |
| Managed worktrees | Two distinct worktrees completed; external source read appeared in the first result; continuation contents were exactly `continued worktree content\n`. |
| Cleanup | Dirty cleanup was refused without opt-in, both explicit removals succeeded, original tracked/untracked sentinels survived, and cached historical results remained available. |

The final smoke JSON reported `passed`, `usage_snapshot_verified`, `repeated_result_identical`, `failed_no_change.passed`, `cancelled_run.passed`, and `managed_worktrees.passed` as true. Owned child PIDs listed in its shutdown output were subsequently confirmed gone. The pre-existing OpenCode service (PID 3494) was left untouched.

Local implementation-session logs were saved at:

- `/tmp/opencode-mcp-final-coverage.log`
- `/private/tmp/opencode-mcp-paid-smoke-retry-20261031-102442.log`

These are temporary, machine-local artifacts, not versioned dependencies of this report. Their relevant commands and outcomes are recorded above. Creating the delivery commit does not require repeating paid model calls.

### Failed attempts and corrective actions

Successful final verification did not erase earlier failures:

- **Observation/pagination:** the initial paid smoke created its file but could not finalize reliably. CLI 2 message pagination and observation handling were corrected rather than increasing error thresholds or fabricating completion.
- **Smoke summary:** a later workflow completed but serialization referenced removed variables. The stale references were removed, and a separate harness typecheck was added to catch this class of defect before model execution.
- **Source/worktree ambiguity:** an independent smoke successfully read the external source, then the model tried to patch that source instead of the worktree. The read-only policy correctly rejected the write, so the run failed. Inspection of the actual stored messages established the cause. The fixture now explicitly separates the read-only external path from the worktree-relative edit target; exact continuation file contents were additionally asserted. Permissions and success checks were not weakened.

## Review and delivery boundaries

The migration is delivered as **one atomic commit**, including runtime, matching tests, smoke/CI changes, current guidance, and this report. It also includes the pre-existing local server/launcher work that was integrated during the migration, as requested. The protocol change crosses these components; separating files by type would leave incompatible intermediate SDK/API states.

This is a large change exceeding a small-review budget. Review it by behavior:

1. Authentication, launcher ownership, and client/message normalization.
2. Dispatch, continuation, cancellation, finalization, and historical snapshots.
3. Permission scopes and managed-worktree behavior.
4. Discovery compatibility, smoke assertions, CI, and user guidance.

Each implementation area has corresponding tests under `tests/`. No PR, merge to `main`, push, npm publication, CLI replacement, or global configuration change is part of this delivery. Historical changelog entries and the previous incident report remain historical.

**Rollback:** revert the migration commit as a complete integration unit rather than restoring individual v1 adapter files into the CLI 2 implementation. The commit includes the integrated pre-existing launcher edits; preserve any desired portions before reverting. Reverting source code does not change the installed CLI and does not make the old adapter compatible with CLI 2. Avoid destructive resets of unrelated work.

## Using the migrated checkout

1. Ensure Node.js `22.18+` and the verified OpenCode CLI `2.2.1` are available and configured.
2. Install dependencies according to the active package-manager policy, then run `pnpm build`.
3. Point the MCP host at this checkout's `build/src/index.js` and restart the host. Rebuilding alone does not replace code already loaded by a running MCP process.
4. Optionally run `pnpm smoke --contract-only`. Run the full `pnpm smoke` only with credentials and authorization for possible model charges.

The published npm package `1.3.1` still contains the previous CLI 1 adapter; `npx -y mcp-server-opencode` does not pick up this unreleased branch. Worktrees are not security sandboxes, caller checks run with the local user's privileges, and task/history/workspace ownership registries remain process-local. Restarting loses those records and does not automatically rediscover retained worktrees.

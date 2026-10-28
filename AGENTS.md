# AGENTS.md

Guidance for OpenCode sessions working in this repo.

## Project

`opencode-mcp` — an MCP server (stdio transport) that lets an MCP host drive an [OpenCode](https://opencode.ai) instance and delegate work to its subagents. Built on `@modelcontextprotocol/sdk` + Zod, with real OpenCode integration via `@opencode-ai/sdk` (`createOpencodeServer` / `createOpencodeClient`).

Task delegation is **asynchronous**: `opencode_start_task` creates a session and fires `promptAsync` (fire-and-forget), returning a `task_id` immediately. Status/result are polled separately via `get_task_status` / `get_task_result`, or long-polled via `opencode_wait_for_task` (`mode: "all"` / `"any"`).

## Commands

Runtime requires **Node.js 18+**; development and native TypeScript smoke tests require **Node.js 22.18+**. CI checks the development suite on Node.js 22 and 24. Package manager is **pnpm** (only `pnpm-lock.yaml` exists). Scripts call `npx`/`pnpx` internally, which works regardless of how you invoke them.

- `pnpm dev` — launch the MCP Inspector against the server via `tsx` (runs TS directly, no build needed). Use this to test tool wiring interactively.
- `pnpm test` — `vitest run` (full suite).
- `pnpm test:coverage` — `vitest run --coverage`. Coverage thresholds are **100%** for lines, branches, functions, and statements (see `vitest.config.ts`) — any uncovered line fails the run.
- Single test file: `pnpm vitest run tests/modules/tools/wait_for_task.test.ts`. Single test by name: add `-t "test name"`.
- `pnpm build` — clean build: `rm -rf build && tsc && chmod +x build/src/index.js`. **This is also the source typecheck** (no separate `typecheck` script). Tests under `tests/` are outside the build; Vitest transpiles them without typechecking.
- `pnpm smoke --message-id-only` — real, non-billable OpenCode message-ID contract probe. `pnpm smoke` runs the full paid smoke; `OPENCODE_MCP_SMOKE_MODEL` overrides its default model.
- `pnpm lint` — `biome check .` (read-only).
- `pnpm lint:write` — biome check + autofix (lint + format).
- `pnpm lint:format` — biome format only.

## Testing

Every module has a `<name>.test.ts` Vitest suite under the parallel `tests/` tree mirroring `src/` (e.g. `src/modules/tools/start_task.ts` → `tests/modules/tools/start_task.test.ts`; see `vitest.config.ts` `include`). `src/test-utils/fake-mcp-server.ts` provides a fake `McpServer` for testing tool/prompt registration without a real transport. Tests run in a `node` environment; `src/test-utils/` is excluded from coverage. When adding or changing a module, keep its test file at 100% coverage or `pnpm test:coverage` fails.

## Architecture

- Entrypoint: `src/index.ts` — creates `McpServer`, calls `registerTools(server)`, and connects a `StdioServerTransport`. Signal handlers drain check processes before stopping tracked OpenCode servers; an `exit` handler provides best-effort cleanup. Hard kills cannot run these handlers. Its advertised version must match `package.json`; `tests/index.test.ts` checks this.
- All tools live in `src/modules/tools/*.ts`. Each exports a `registerOpencode<Name>(server: McpServer)` function that calls `server.registerTool(...)`. They are wired together in `src/modules/tools/index.ts`.
- Delegation guidance is supplied through MCP server instructions in `shared/instructions.ts`; no MCP prompts are currently registered.
- Registered tool names are prefixed `opencode_` (e.g. `opencode_start_task`); the source filenames are not prefixed (`start_task.ts`).
- `src/modules/shared/` holds cross-tool infrastructure:
  - `server-registry.ts` — in-memory `Map<serverId, { serverId, baseUrl, close }>`; `killAllServers()` reaps every tracked child on shutdown.
  - `task-registry.ts` — in-memory `Map<taskId, TaskRecord>` linking tasks to OpenCode sessions and retaining per-run dispatch, report, result, and usage history. `markTaskCancelled()` stamps `cancelledAt`; `cancel_task` calls it after a successful abort. Aborting alone leaves no trace — the session's last assistant message keeps its completed timestamp — so without the stamp a deliberately killed task reads as a normal success.
  - `opencode-client.ts` — `clientForServer(id)` / `clientForTask(id)` build `OpencodeClient`s from the registries. `assistantEntries()` fetches every assistant message for a session (one HTTP call); `lastAssistantEntry()` is `.at(-1)` of that, and `sessionParts()` flattens them. `deriveTaskStatus()` checks `cancelledAt` first and returns `cancelled` before any session lookup, then returns `empty` — not `completed` — when a finished turn has no text and no tool calls, because a completed timestamp says the turn ended, not that it did work. `buildProgress(latest, whole)` reads `text_snippet` / `current_tool` from the **latest** turn but `tool_calls_completed` / `mutating_tool_calls` / `files_touched` from **all turns in the current run**: an agent's edits land in earlier turns while the final turn is usually just "DONE", so evidence read off the last message alone reports `files_touched: []` for a task that rewrote the workspace.
  - `mcp-result.ts` — `jsonResult()` / `jsonError()` helpers that serialize a payload as an MCP text tool result (use these for consistent output).
  - `instructions.ts` — `createDelegateTaskInstructions()` builds the MCP server instructions. It is **async**: it awaits the quota snapshot before returning, so `src/index.ts` awaits `createServer()`. It embeds only the *spend budget* plus the static tier legend — per-model quotas are deliberately NOT repeated here, because `opencode_list_agents` reports them keyed by the real model id. Don't reintroduce a model table: it would be a second, name-keyed copy of data the agent must fetch anyway.
  - `usage-limits.ts` — exports `quotaTier()` (the thresholds live there only), `quotaByModelId()`, which indexes the snapshot by slugified display name so live model ids join onto docs rows (`MiMo-V2.5` → `mimo-v2.5`), `formatUsageLimits()` (source + spend budget, for the instructions) and `formatTierGuide()` (static legend keyed by the exact `tier` values `opencode_list_agents` emits). `opencode_list_agents` uses `quotaTier`/`quotaByModelId` to annotate every model with its quota. Scrapes the OpenCode Go quota table from https://opencode.ai/docs/es/go/ and renders it as the model-selection block inside the instructions. The snapshot is cached on disk (`OPENCODE_MCP_CACHE_DIR` > `XDG_CACHE_HOME` > `~/.cache`, under `opencode-mcp/usage-limits.json`) and refetched at most once every 24h (`OPENCODE_MCP_LIMITS_TTL_MS` overrides the TTL). A failed fetch falls back to the stale snapshot, then to a quota-agnostic paragraph — startup never depends on the network. Model tiers (high volume / balanced / scarce) are derived from the live req/5h numbers, not hardcoded model names, so the block stays correct when OpenCode changes its lineup.
  - `permissions.ts` — keeps delegated tasks from wedging on permission prompts. A headless `opencode serve` has no interactive approver, so any permission resolved to `ask` blocks the agent **forever**: the session stays genuinely `busy` and the task neither completes nor fails. Two layers: `buildServerConfig()` is passed to `createOpencodeServer` (OpenCode deep-merges it per permission key, so the user's own `read`/`edit`/`bash` deny globs survive untouched), and `startPermissionResponder()` subscribes to the event stream and answers every request. `getExternalDirectoryPolicy()` resolves the policy: `OPENCODE_MCP_EXTERNAL_DIR` env var > `OPENCODE_MCP_EXTERNAL_DIR=<policy>` CLI arg > `read-only` default. Policies: `read-only` (reads outside the cwd approved, writes rejected), `allow`, `deny`. Inside the cwd everything is auto-approved — the caller already owns that directory. External reads are answered `once`, never `always`, because an `always` reply persists keyed by *directory pattern* rather than by operation and would silently let a later write into the same directory through.
  - `config.ts` — `getMaxToolTimeoutMs()` resolves the server-side clamp for `opencode_wait_for_task` timeouts: `MCP_TOOL_TIMEOUT` env var > `MCP_TOOL_TIMEOUT=<ms>` CLI arg > 300000 ms default. Reads `process.env`/`process.argv` lazily on each call so tests can vary them.
- `run-observer.ts` finalizes runs in the background; `execution-report.ts` captures independent workspace evidence and executes bounded checks; `execution-usage.ts` aggregates direct-message metrics. `workspace-manager.ts` / `git-workspace.ts` manage detached worktrees and explicit cleanup, while `permission-scopes.ts` routes permission responses by server, directory, and registered session.
- Task, server, and workspace ownership registries are process-local; restarting does not restore them. Retained worktrees are not automatically rediscovered. Worktrees are not security sandboxes; checks run with the MCP process user's privileges.

`opencode_list_agents` returns `models.providers[].models` as objects (`{ id, quota }`), **not** plain id strings, plus a sibling `models.quota_snapshot` (`{ source, checked }` or `null`) that distinguishes "this model has no quota row" from "we never got the table". `quota` is `null` for models absent from the OpenCode Go docs — verified against a live server, all 22 `opencode-go` ids match a docs row and the 7 `opencode` free/preview models do not.

### Adding a tool

1. Create `src/modules/tools/<name>.ts` exporting `registerOpencode<Name>(server: McpServer)`.
2. Register it in `src/modules/tools/index.ts` (import + call inside `registerTools`).
3. The tool name passed to `server.registerTool` must be `opencode_<name>`; define `inputSchema` with Zod.
4. Reuse `shared/mcp-result.ts` (`jsonResult`/`jsonError`) for results and `shared/opencode-client.ts` (`clientForServer`/`clientForTask`) for SDK access instead of constructing clients ad hoc — other tools rely on the registries staying the source of truth for server/task identity.
5. Add `tests/modules/tools/<name>.test.ts` (use `src/test-utils/fake-mcp-server.ts` to capture the registration) — coverage thresholds are 100%.

## Gotchas

- **OpenCode version support**: the adapter uses the v1 SDK/API and was validated against OpenCode `1.18.34`. OpenCode 2.x is not yet supported; a real smoke against `2.2.0` times out at server startup. Do not claim compatibility without a real contract/smoke run.
- **The generated SDK types lag the running binary.** Verified against opencode `1.18.18` with `@opencode-ai/sdk` `1.17.20`: the live permission event is `permission.asked` (the SDK declares only `permission.updated`), its kind arrives as `properties.permission` (the SDK's `Permission` says `type`), and the call id is nested under `properties.tool.callID` (the SDK puts it at the top level). `shared/permissions.ts` declares its own `PermissionAsk` and reads both spellings. The SDK's `Config.permission` is stale too — it types `edit` as a bare `"ask" | "allow" | "deny"`, but the binary accepts an object of globs. **Verify wire shapes against a live server before trusting a generated type**; a mismatch here fails silently, because a permission that is never answered just hangs.
- **ESM + NodeNext**: `"type": "module"` with `moduleResolution: NodeNext`. All relative imports in `.ts` files must use `.js` extensions (e.g. `from "./modules/tools/index.js"`), even though the source is `.ts`.
- **Build output lives at `build/src/index.js`** (not `build/index.js`) because `rootDir` is `"./"` with sources under `src/`. `package.json` `main`/`bin` correctly point there; keep them in sync if `rootDir` ever changes. `pnpm build` wipes `build/` first and `chmod +x`'s the entrypoint (it has a shebang), and `prepare` runs the build on install.
- **Build scope**: `tsconfig.json` includes `src/**/*.ts` and excludes test files and `src/test-utils/**`, so test helpers are not compiled into the published package.
- Biome: 2-space indent, 100 cols, double quotes, organizes imports on write. `build/` is excluded via both `.gitignore` and biome's `!!**/build` negation.

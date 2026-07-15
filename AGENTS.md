# AGENTS.md

Guidance for OpenCode sessions working in this repo.

## Project

`opencode-mcp` — an MCP server (stdio transport) that lets an MCP host drive an [OpenCode](https://opencode.ai) instance and delegate work to its subagents. Built on `@modelcontextprotocol/sdk` + Zod, with real OpenCode integration via `@opencode-ai/sdk` (`createOpencodeServer` / `createOpencodeClient`).

Task delegation is **asynchronous**: `opencode_start_task` creates a session and fires `promptAsync` (fire-and-forget), returning a `task_id` immediately. Status/result are polled separately via `get_task_status` / `get_task_result`, or long-polled via `opencode_wait_for_task` (`mode: "all"` / `"any"`).

## Commands

Package manager is **pnpm** (only `pnpm-lock.yaml` exists). Scripts call `npx`/`pnpx` internally, which works regardless of how you invoke them.

- `pnpm dev` — launch the MCP Inspector against the server via `tsx` (runs TS directly, no build needed). Use this to test tool wiring interactively.
- `pnpm test` — `vitest run` (full suite).
- `pnpm test:coverage` — `vitest run --coverage`. Coverage thresholds are **100%** for lines, branches, functions, and statements (see `vitest.config.ts`) — any uncovered line fails the run.
- Single test file: `pnpm vitest run src/modules/tools/wait_for_task.test.ts`. Single test by name: add `-t "test name"`.
- `pnpm build` — clean build: `rm -rf build && tsc && chmod +x build/src/index.js`. **This is also the typecheck** (no separate `typecheck` script). Note: `tsconfig.json` excludes `src/**/*.test.ts`, so type errors in test files only surface through vitest, not `pnpm build`.
- `pnpm lint` — `biome check .` (read-only).
- `pnpm lint:write` — biome check + autofix (lint + format).
- `pnpm lint:format` — biome format only.

## Testing

Every module has a colocated `<name>.test.ts` Vitest suite next to its source. `src/test-utils/fake-mcp-server.ts` provides a fake `McpServer` for testing tool/prompt registration without a real transport. Tests run in a `node` environment; `src/test-utils/` is excluded from coverage. When adding or changing a module, keep its test file at 100% coverage or `pnpm test:coverage` fails.

## Architecture

- Entrypoint: `src/index.ts` — creates `McpServer`, calls `registerTools(server)` and `registerPrompts(server)`, connects a `StdioServerTransport`. Installs `SIGHUP`/`SIGINT`/`SIGTERM`/`exit` handlers that call `killAllServers()` so no `opencode serve` child outlives the MCP process.
- All tools live in `src/modules/tools/*.ts`. Each exports a `registerOpencode<Name>(server: McpServer)` function that calls `server.registerTool(...)`. They are wired together in `src/modules/tools/index.ts`.
- MCP prompts live in `src/modules/prompts/*.ts`, each exporting a `register<Name>Prompt(server: McpServer)` function that calls `server.registerPrompt(...)`. They are wired together in `src/modules/prompts/index.ts` via `registerPrompts`.
- Registered tool names are prefixed `opencode_` (e.g. `opencode_start_task`); the source filenames are not prefixed (`start_task.ts`).
- `src/modules/shared/` holds cross-tool infrastructure:
  - `server-registry.ts` — in-memory `Map<serverId, { serverId, baseUrl, close }>`; `killAllServers()` reaps every tracked child on shutdown.
  - `task-registry.ts` — in-memory `Map<taskId, { taskId, serverId, sessionId }>` linking a delegated task to its OpenCode session.
  - `opencode-client.ts` — `clientForServer(id)` / `clientForTask(id)` build `OpencodeClient`s from the registries; `lastAssistantEntry()` walks session messages to find the latest assistant turn (used to derive status and results).
  - `mcp-result.ts` — `jsonResult()` / `jsonError()` helpers that serialize a payload as an MCP text tool result (use these for consistent output).
  - `config.ts` — `getMaxToolTimeoutMs()` resolves the server-side clamp for `opencode_wait_for_task` timeouts: `MCP_TOOL_TIMEOUT` env var > `MCP_TOOL_TIMEOUT=<ms>` CLI arg > 300000 ms default. Reads `process.env`/`process.argv` lazily on each call so tests can vary them.
- `src/domain`, `src/application`, `src/infrastructure` contain only **empty subdirectories** (no `.ts` files). The real code lives in `src/modules/`; don't treat the Clean Architecture folders as populated layers.

### Adding a tool

1. Create `src/modules/tools/<name>.ts` exporting `registerOpencode<Name>(server: McpServer)`.
2. Register it in `src/modules/tools/index.ts` (import + call inside `registerTools`).
3. The tool name passed to `server.registerTool` must be `opencode_<name>`; define `inputSchema` with Zod.
4. Reuse `shared/mcp-result.ts` (`jsonResult`/`jsonError`) for results and `shared/opencode-client.ts` (`clientForServer`/`clientForTask`) for SDK access instead of constructing clients ad hoc — other tools rely on the registries staying the source of truth for server/task identity.
5. Add a colocated `<name>.test.ts` (use `src/test-utils/fake-mcp-server.ts` to capture the registration) — coverage thresholds are 100%.

## Gotchas

- **ESM + NodeNext**: `"type": "module"` with `moduleResolution: NodeNext`. All relative imports in `.ts` files must use `.js` extensions (e.g. `from "./modules/tools/index.js"`), even though the source is `.ts`.
- **Build output lives at `build/src/index.js`** (not `build/index.js`) because `rootDir` is `"./"` with sources under `src/`. `package.json` `main`/`bin` correctly point there; keep them in sync if `rootDir` ever changes. `pnpm build` wipes `build/` first and `chmod +x`'s the entrypoint (it has a shebang), and `prepare` runs the build on install.
- **`tsconfig.json` `include` has stale globs**: `["index.ts", "src/**/*.ts", "bin/**/*.ts"]`. The root `index.ts` and `bin/**/*.ts` don't exist — they're harmless no-ops (tsc ignores missing globs). `src/**/*.ts` is the glob that actually compiles the codebase.
- Biome: 2-space indent, 100 cols, double quotes, organizes imports on write. `build/` is excluded via both `.gitignore` and biome's `!!**/build` negation.

# AGENTS.md

Guidance for OpenCode sessions working in this repo.

## Project

`opencode-mcp` — an MCP server (stdio transport) that lets an MCP host drive an [OpenCode](https://opencode.ai) instance and delegate work to its subagents. Built on `@modelcontextprotocol/sdk` + Zod, with real OpenCode integration via `@opencode-ai/sdk` (`createOpencodeServer` / `createOpencodeClient`).

Task delegation is **asynchronous**: `opencode_start_task` creates a session and fires `promptAsync` (fire-and-forget), returning a `task_id` immediately. Status/result are polled separately via `get_task_status` / `get_task_result`.

## Commands

Package manager is **pnpm** (only `pnpm-lock.yaml` exists). Scripts call `npx`/`pnpx` internally, which works regardless of how you invoke them.

- `pnpm dev` — launch the MCP Inspector against the server via `tsx` (runs TS directly, no build needed). Use this to test tool wiring interactively.
- `pnpm build` — `tsc` → `build/`. **This is also the typecheck** (no separate `typecheck` script).
- `pnpm lint` — `biome check .` (read-only).
- `pnpm lint:write` — biome check + autofix (lint + format).
- `pnpm lint:format` — biome format only.

There is **no test setup** — no runner, no test files. Don't assume a test command exists; to verify work, run `pnpm lint` then `pnpm build`.

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
- `src/domain`, `src/application`, `src/infrastructure` contain only **empty subdirectories** (no `.ts` files). The real code lives in `src/modules/`; don't treat the Clean Architecture folders as populated layers.

### Adding a tool

1. Create `src/modules/tools/<name>.ts` exporting `registerOpencode<Name>(server: McpServer)`.
2. Register it in `src/modules/tools/index.ts` (import + call inside `registerTools`).
3. The tool name passed to `server.registerTool` must be `opencode_<name>`; define `inputSchema` with Zod.
4. Reuse `shared/mcp-result.ts` (`jsonResult`/`jsonError`) for results and `shared/opencode-client.ts` (`clientForServer`/`clientForTask`) for SDK access instead of constructing clients ad hoc — other tools rely on the registries staying the source of truth for server/task identity.

## Gotchas

- **ESM + NodeNext**: `"type": "module"` with `moduleResolution: NodeNext`. All relative imports in `.ts` files must use `.js` extensions (e.g. `from "./modules/tools/index.js"`), even though the source is `.ts`.
- **`package.json` `main`/`bin` point at the wrong path.** They declare `./build/index.js`, but `tsconfig.json` has `rootDir: "./"` with all sources under `src/`, so `pnpm build` actually emits the entrypoint at `build/src/index.js`. A clean rebuild (`rm -rf build && pnpm build`) leaves **no** `build/index.js`, breaking the package metadata. The stale `build/index.js` currently sitting in the working tree is a leftover from a removed root `index.ts` (the old weather-API example) — don't trust it. Fix by pointing `main`/`bin` at `./build/src/index.js` (or setting `rootDir: "./src"`).
- **`build/` is stale and gitignored.** It contains compiled leftovers from a removed weather-API example (`nws-api-client`, `weather-formatter`, `get-alerts-use-case`, `weather-repository`, `weather` models) under `build/src/` that no longer exist in `src/`. Never treat `build/` as source of truth; rebuild with `pnpm build` (and `rm -rf build` first if you want a clean tree).
- **`tsconfig.json` `include` has stale globs**: `["index.ts", "src/**/*.ts", "bin/**/*.ts"]`. The root `index.ts` and `bin/**/*.ts` don't exist — they're harmless no-ops (tsc ignores missing globs). `src/**/*.ts` is the glob that actually compiles the codebase.
- Biome: 2-space indent, 100 cols, double quotes, organizes imports on write. `build/` is excluded via both `.gitignore` and biome's `!!**/build` negation.

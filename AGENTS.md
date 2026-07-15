# AGENTS.md

Guidance for OpenCode sessions working in this repo.

## Project

`opencode-mcp` — an MCP server (stdio transport) that exposes OpenCode operations as MCP tools. Built on `@modelcontextprotocol/sdk` + Zod. Currently a **skeleton**: every tool handler returns mock data; no real OpenCode server integration is wired yet.

## Commands

Package manager is **pnpm** (only `pnpm-lock.yaml` exists). Scripts call `npx`/`pnpx` internally, which works regardless of how you invoke them.

- `pnpm dev` — launch the MCP Inspector against the server via `tsx` (runs TS directly, no build needed). Use this to test tool wiring interactively.
- `pnpm build` — `tsc` → `build/`. **This is also the typecheck** (no separate `typecheck` script).
- `pnpm lint` — `biome check .` (read-only).
- `pnpm lint:write` — biome check + autofix (lint + format).
- `pnpm lint:format` — biome format only.

There is **no test setup** — no runner, no test files. Don't assume a test command exists; to verify work, run `pnpm lint` then `pnpm build`.

## Architecture

- Entrypoint: `src/index.ts` — creates `McpServer`, calls `registerTools(server)`, connects a `StdioServerTransport`.
- All tools live in `src/modules/tools/*.ts`. Each exports a `registerOpencode<Name>(server: McpServer)` function that calls `server.registerTool(...)`. They are wired together in `src/modules/tools/index.ts`.
- Registered tool names are prefixed `opencode_` (e.g. `opencode_start_task`); the source filenames are not prefixed (`start_task.ts`).
- `src/domain`, `src/application`, `src/infrastructure` are **empty scaffolding** — no files. Don't treat them as populated Clean Architecture layers.

### Adding a tool

1. Create `src/modules/tools/<name>.ts` exporting `registerOpencode<Name>(server: McpServer)`.
2. Register it in `src/modules/tools/index.ts` (import + call inside `registerTools`).
3. The tool name passed to `server.registerTool` must be `opencode_<name>`; define `inputSchema` with Zod.

## Gotchas

- **ESM + NodeNext**: `"type": "module"` with `moduleResolution: NodeNext`. All relative imports in `.ts` files must use `.js` extensions (e.g. `from "./modules/tools/index.js"`), even though the source is `.ts`.
- **`build/` is stale and gitignored.** It contains compiled leftovers from a removed weather-API example (`nws-api-client`, `weather-formatter`, `get-alerts-use-case`, etc.) that no longer exist in `src/`. Never treat `build/` as source of truth; rebuild with `pnpm build`.
- `tsconfig.json` `include` references `index.ts` and `bin/**/*.ts` — neither exists. The real entrypoint is `src/index.ts`; those entries are stale no-ops (tsc ignores missing globs).
- Biome: 2-space indent, 100 cols, double quotes, organizes imports on write. `build/` is excluded via both `.gitignore` and biome's `!!**/build` negation.

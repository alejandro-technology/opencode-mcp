# opencode-mcp

An MCP (Model Context Protocol) server that lets Claude Code drive an [OpenCode](https://opencode.ai) instance and delegate work to its subagents — so orchestrator models like Opus or Fable can hand off tasks to the other models OpenCode exposes.

```
Claude Code
      │
      ▼
MCP Server  (this project)
      │
      ▼
OpenCode SDK / CLI
      │
      ▼
Subagents
```

## Status

Functional. All tools are wired to real OpenCode instances via `@opencode-ai/sdk` (`createOpencodeServer` / `createOpencodeClient`), covered by a Vitest suite. The server also installs `SIGHUP`/`SIGINT`/`SIGTERM`/`exit` handlers so no `opencode serve` child process outlives the MCP process.

## Design

Task delegation is **asynchronous**: starting a task returns immediately with a `task_id` instead of blocking until the subagent finishes. This lets Claude Code fire multiple `opencode_start_task` calls in parallel — each one opens an isolated OpenCode `Session` — without hitting MCP client timeouts on long-running work. Status and results are fetched separately via polling.

## Tools

| Tool | Description |
| --- | --- |
| `opencode_start_server` | Start (or attach to) an OpenCode server instance |
| `opencode_stop_server` | Stop a running OpenCode server instance |
| `opencode_list_agents` | List agents/models available on a server instance |
| `opencode_start_task` | Delegate a task to an agent by starting a new session and prompt |
| `opencode_get_task_status` | Poll the status of a delegated task (`pending` / `running` / `completed` / `failed`) |
| `opencode_get_task_result` | Fetch the final result of a completed task |
| `opencode_wait_for_task` | Long-poll one or more delegated tasks until they finish (`mode: "all"` or `"any"`) or the timeout elapses |

## Prompts

| Prompt | Description |
| --- | --- |
| `delegate_task` | Guides the host through delegating one or more tasks to OpenCode agents (start/wait/result workflow) |

## Configuration

### `MCP_TOOL_TIMEOUT`

`opencode_wait_for_task` accepts a `timeout_ms` input, but it's clamped to a server-side maximum so a single call can't block the MCP connection indefinitely. That maximum defaults to **300000 ms (5 minutes)** and is configurable via `MCP_TOOL_TIMEOUT`.

`MCP_TOOL_TIMEOUT` can be set two ways:

- **Environment variable** — set it in the MCP server config:

  ```json
  {
    "mcpServers": {
      "opencode": {
        "command": "node",
        "args": ["/path/to/opencode-mcp/build/src/index.js"],
        "env": { "MCP_TOOL_TIMEOUT": "1200000" }
      }
    }
  }
  ```

- **CLI argument** — pass `MCP_TOOL_TIMEOUT=<ms>` as an extra arg to the server process:

  ```json
  {
    "mcpServers": {
      "opencode": {
        "command": "node",
        "args": ["/path/to/opencode-mcp/build/src/index.js", "MCP_TOOL_TIMEOUT=1200000"]
      }
    }
  }
  ```

If both are present, the **environment variable takes precedence** over the CLI argument. Invalid or non-numeric values fall back to the 300000 ms default.

Note that raising this value only raises the server-side clamp — the MCP *client's* own tool-call timeout (e.g. Claude Code's) must also be set to a value **greater than or equal to** this max, or the client will abort the call before `opencode_wait_for_task` has a chance to return.

## Project structure

```
src/
├── index.ts                   # MCP server entrypoint (stdio transport, shutdown handlers)
└── modules/
    ├── tools/                 # One file per MCP tool, registered in index.ts
    ├── prompts/               # One file per MCP prompt, registered in index.ts
    └── shared/                # Cross-tool infrastructure
        ├── server-registry.ts   # Tracks running OpenCode servers; killAllServers() on shutdown
        ├── task-registry.ts     # Maps task_id → OpenCode server + session
        ├── opencode-client.ts   # Builds SDK clients from the registries
        ├── config.ts            # MCP_TOOL_TIMEOUT resolution (env var / CLI arg)
        └── mcp-result.ts        # jsonResult / jsonError MCP output helpers
```

Each module ships with a colocated `*.test.ts` Vitest suite.

## Getting started

```bash
pnpm install
pnpm dev     # runs the server through the MCP Inspector (tsx, no build needed)
```

Other scripts:

```bash
pnpm test           # vitest run
pnpm test:coverage  # vitest run --coverage
pnpm lint           # biome check
pnpm lint:write     # biome check --write
pnpm build          # clean tsc build to ./build (also the typecheck)
```

To use it from an MCP host, build and point the host at the executable entrypoint:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/opencode-mcp/build/src/index.js"]
    }
  }
}
```

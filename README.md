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

Early scaffolding. The MCP tool contracts are defined and mocked (static responses, no OpenCode SDK wiring yet). Next step is implementing the real logic behind each tool using `@opencode-ai`'s SDK (`createOpencode()`).

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
├── index.ts                  # MCP server entrypoint (stdio transport)
├── modules/
│   └── tools/                # One file per MCP tool, registered in index.ts
├── application/               # Use cases (empty, pending OpenCode SDK integration)
├── domain/                    # Models and repository interfaces (empty)
└── infrastructure/            # External clients, e.g. the OpenCode SDK client (empty)
```

## Getting started

```bash
pnpm install
pnpm dev     # runs the server through the MCP Inspector
```

Other scripts:

```bash
pnpm lint          # biome check
pnpm lint:write     # biome check --write
pnpm build         # tsc build to ./build
```

## Roadmap

- [ ] Wire `opencode_start_server` / `opencode_stop_server` to `createOpencode()` / `createOpencodeClient()`
- [ ] Wire `opencode_list_agents` to `app.agents()`
- [ ] Implement an in-memory task store (`task_id` → `session_id` + status) backing `start_task` / `get_task_status` / `get_task_result`
- [ ] Error handling for unreachable/crashed OpenCode instances

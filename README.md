# opencode-mcp

An MCP (Model Context Protocol) server that lets any MCP host — Claude Code, Codex CLI, Cursor, etc. — drive an [OpenCode](https://opencode.ai) instance and delegate work to its subagents — so orchestrator models like Opus or Fable can hand off tasks to the other models OpenCode exposes.

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

## Design

Task delegation is **asynchronous**: starting a task returns immediately with a `task_id` instead of blocking until the subagent finishes. This lets Claude Code fire multiple `opencode_start_task` calls in parallel — each one opens an isolated OpenCode `Session` — without hitting MCP client timeouts on long-running work. Status and results are fetched separately via polling.

## Tools

| Tool                       | Description                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `opencode_start_server`    | Start (or attach to) an OpenCode server instance                                                          |
| `opencode_stop_server`     | Stop a running OpenCode server instance                                                                   |
| `opencode_list_agents`     | List agents/models available on a server instance                                                         |
| `opencode_start_task`      | Delegate a task to an agent by starting a new session and prompt (optional `agent` / `model` override)    |
| `opencode_continue_task`   | Send a follow-up prompt to an existing task's session for iterative back-and-forth with the subagent      |
| `opencode_cancel_task`     | Abort a running delegated task by cancelling its session                                                  |
| `opencode_get_task_status` | Poll the status of a delegated task (`pending` / `running` / `completed` / `failed`)                      |
| `opencode_get_task_result` | Fetch the final result of a completed task                                                                |
| `opencode_wait_for_task`   | Long-poll one or more delegated tasks until they finish (`mode: "all"` or `"any"`) or the timeout elapses |


| Prompt          | Description                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `delegate_task` | Guides the host through delegating one or more tasks to OpenCode agents (start/wait/result workflow), including a model selection guide that maps each OpenCode model tier to the task difficulty it should handle |

## Installation

### Prerequisites

- **Node.js 18+**
- **[OpenCode](https://opencode.ai)** installed and configured (`opencode` must be on your `PATH`, with at least one provider/model set up) — this server spawns and drives OpenCode instances.

### Option 1 — npm (recommended)

The package is published as [`mcp-server-opencode`](https://www.npmjs.com/package/mcp-server-opencode). No cloning or building needed — point your MCP host at `npx`:

For **Claude Code**, one command does it:

```bash
claude mcp add opencode -- npx -y mcp-server-opencode
```

Or manually

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "mcp-server-opencode"]
    }
  }
}
```

For **Codex CLI**, add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.opencode]
command = "npx"
args = ["-y", "mcp-server-opencode"]
```

Or install it globally and use the binary directly:

```bash
npm install -g mcp-server-opencode
```

```json
{
  "mcpServers": {
    "opencode": {
      "command": "opencode-mcp"
    }
  }
}
```

### Option 2 — from source

```bash
git clone https://github.com/alejandro-technology/opencode-mcp.git
cd opencode-mcp
pnpm install
pnpm build
```

Then point your MCP host at the built entrypoint:

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

Restart your MCP host after editing the config; the `opencode_*` tools should appear in its tool list.

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
        "args": [
          "/path/to/opencode-mcp/build/src/index.js",
          "MCP_TOOL_TIMEOUT=1200000"
        ]
      }
    }
  }
  ```

If both are present, the **environment variable takes precedence** over the CLI argument. Invalid or non-numeric values fall back to the 300000 ms default.

Note that raising this value only raises the server-side clamp — the MCP _client's_ own tool-call timeout (e.g. Claude Code's) must also be set to a value **greater than or equal to** this max, or the client will abort the call before `opencode_wait_for_task` has a chance to return.

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

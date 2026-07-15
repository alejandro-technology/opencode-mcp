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

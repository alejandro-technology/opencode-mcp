import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DELEGATE_TASK_INSTRUCTIONS = `You have access to the opencode-mcp server, which lets you delegate work to OpenCode agents. Follow this workflow whenever you delegate tasks:

Recommended models: run delegated tasks with Fable 5, Opus 4.8, or GPT 5.6 Sol. When overriding an agent's model via opencode_start_task, prefer one of these.

Workflow:
1. Ensure an OpenCode server is running. If you don't already have a server_id from a previous opencode_start_server call, call opencode_start_server first.
2. Call opencode_list_agents with the server_id to discover the available agents (native and custom) and models. Agents may have a pre-assigned model ("provider/model"); you can still override it per task.
3. For each task, call opencode_start_task with the server_id and the task's prompt. Optionally pass an agent name and/or a model override. Collect the returned task_id for every call.
4. Wait for completion with opencode_wait_for_task:
   - Single task: mode "all" with the single task_id.
   - Multiple tasks, incremental results: call it repeatedly with mode "any", removing completed task_ids each time.
   - Multiple tasks, all at once: call it once with mode "all" and every task_id.
5. Once a task is reported finished, call opencode_get_task_result for that task_id to retrieve its output.
6. Use opencode_get_task_status only for quick, non-blocking checks on a task's progress (e.g. to report status to the user) — it does not replace opencode_wait_for_task or opencode_get_task_result.

Do not call opencode_get_task_result before the task has finished, and prefer opencode_wait_for_task over polling opencode_get_task_status in a loop.`;

export function registerDelegateTaskPrompt(server: McpServer) {
  server.registerPrompt(
    "delegate_task",
    {
      title: "Delegate task to OpenCode",
      description:
        "Instructions for the correct workflow to delegate tasks to OpenCode agents via this MCP server",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: DELEGATE_TASK_INSTRUCTIONS,
          },
        },
      ],
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerDelegateTaskPrompt(server: McpServer) {
  server.registerPrompt(
    "delegate_task",
    {
      title: "Delegate task to OpenCode",
      description: "Guides the host through delegating one or more tasks to OpenCode agents",
      argsSchema: {
        task: z.string().describe("The primary task to delegate"),
        agent: z.string().optional().describe("Agent name to delegate to (e.g. 'build')"),
        parallel_tasks: z
          .string()
          .optional()
          .describe("Comma-separated list of additional tasks to run in parallel"),
      },
    },
    ({ task, agent, parallel_tasks }) => {
      const tasks = [
        task,
        ...(parallel_tasks ? parallel_tasks.split(",").map((t) => t.trim()) : []),
      ].filter((t) => t.length > 0);

      const agentLine = agent
        ? `Use the agent "${agent}" for each task (pass it as the \`agent\` argument to opencode_start_task).`
        : "No specific agent was requested; omit the `agent` argument or pick a suitable one with opencode_list_agents.";

      const taskList = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");

      const waitModeNote =
        tasks.length > 1
          ? 'If the user wants progressive/incremental results as each task finishes, call opencode_wait_for_task repeatedly with mode "any" (removing completed task_ids each time). Otherwise call it once with mode "all" and every task_id.'
          : 'Call opencode_wait_for_task with mode "all" and the single task_id.';

      const text = `Delegate the following task(s) to OpenCode using this workflow:

${taskList}

Workflow:
1. Ensure an OpenCode server is running. If you don't already have a server_id from a previous opencode_start_server call, call opencode_start_server first.
2. For each task above, call opencode_start_task with the server_id and the task's prompt. ${agentLine} Collect the returned task_id for every call.
3. ${waitModeNote}
4. Once opencode_wait_for_task reports a task as finished, call opencode_get_task_result for that task_id to retrieve its output. Do this for every completed task_id.
5. Use opencode_get_task_status only for quick, non-blocking checks on a task's progress (e.g. to report status to the user) — it does not replace opencode_wait_for_task or opencode_get_task_result.

Do not call opencode_get_task_result before the task has finished, and prefer opencode_wait_for_task over polling opencode_get_task_status in a loop.`;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text,
            },
          },
        ],
      };
    },
  );
}

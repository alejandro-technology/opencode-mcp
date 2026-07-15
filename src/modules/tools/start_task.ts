import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerOpencodeStartTask(server: McpServer) {
  server.registerTool(
    "opencode_start_task",
    {
      description: "Delegate a task to an OpenCode agent by starting a new session and prompt",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to run the task on"),
        prompt: z.string().describe("Prompt/instructions for the subagent"),
        agent: z.string().optional().describe("Agent name to delegate the task to"),
        model: z.string().optional().describe("Model to use for the task"),
      },
    },
    async ({ server_id, prompt: _prompt, agent: _agent, model: _model }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              server_id,
              task_id: "mock-task-id",
              session_id: "mock-session-id",
              status: "pending",
            }),
          },
        ],
      };
    },
  );
}

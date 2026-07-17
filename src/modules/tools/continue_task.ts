import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask } from "../shared/opencode-client.js";

/** Parse a "providerID/modelID" string into the shape the SDK expects. */
function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function registerOpencodeContinueTask(server: McpServer) {
  server.registerTool(
    "opencode_continue_task",
    {
      description: "Send a follow-up prompt to an existing delegated task's session",
      inputSchema: {
        task_id: z
          .string()
          .describe("Id of the task whose session should receive the follow-up prompt"),
        prompt: z.string().describe("Follow-up prompt/instructions for the agent"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent name to delegate to (e.g. 'build', 'plan'). Discover available agents with opencode_list_agents. Omit to use the session's current agent",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model override as 'providerID/modelID' (e.g. 'opencode/glm-5.2'). Overrides the agent's pre-assigned model for this follow-up only. Discover available models with opencode_list_agents",
          ),
      },
    },
    async ({ task_id, prompt, agent, model }) => {
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "task_not_found" });
      }
      const { client, sessionId } = resolved;

      let parsedModel: { providerID: string; modelID: string } | undefined;
      if (model !== undefined) {
        parsedModel = parseModel(model);
        if (!parsedModel) {
          return jsonError({
            task_id,
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          });
        }
      }

      try {
        // Fire-and-forget: promptAsync returns as soon as the prompt is accepted,
        // the agent keeps working in the background. Poll with get_task_status.
        await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: prompt }],
            ...(agent ? { agent } : {}),
            ...(parsedModel ? { model: parsedModel } : {}),
          },
        });

        return jsonResult({
          task_id,
          session_id: sessionId,
          status: "pending",
        });
      } catch (error) {
        return jsonError({
          task_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

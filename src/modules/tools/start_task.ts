import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForServer } from "../shared/opencode-client.js";
import { registerTask } from "../shared/task-registry.js";

/** Parse a "providerID/modelID" string into the shape the SDK expects. */
function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function registerOpencodeStartTask(server: McpServer) {
  server.registerTool(
    "opencode_start_task",
    {
      description:
        "Delegate a task to an OpenCode agent: create a session and start the prompt without waiting for it to finish",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to run the task on"),
        prompt: z.string().describe("Prompt/instructions for the agent"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent name to delegate to (e.g. 'build', 'plan'). Discover available agents with opencode_list_agents. Omit to use the server's default agent",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model override as 'providerID/modelID', copied verbatim from opencode_list_agents output — never guess or construct the id from a model's display name. Overrides the agent's pre-assigned model for this task only. An unknown model is rejected with status 'unknown_model' and the list of available models",
          ),
      },
    },
    async ({ server_id, prompt, agent, model }) => {
      const client = clientForServer(server_id);
      if (!client) {
        return jsonError({ server_id, status: "server_not_found" });
      }

      let parsedModel: { providerID: string; modelID: string } | undefined;
      if (model !== undefined) {
        parsedModel = parseModel(model);
        if (!parsedModel) {
          return jsonError({
            server_id,
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          });
        }
      }

      try {
        if (parsedModel) {
          const requested = parsedModel;
          // Validate against the server's real provider/model catalog: promptAsync is
          // fire-and-forget, so an unknown model would otherwise fail silently and the
          // task would look stuck forever. Skip validation if the catalog is unavailable.
          const providersRes = await client.config.providers();
          const providers = providersRes.data?.providers;
          if (providers) {
            const provider = providers.find((p) => p.id === requested.providerID);
            if (!provider || !(requested.modelID in provider.models)) {
              return jsonError({
                server_id,
                status: "unknown_model",
                model,
                message:
                  "model is not available on this server; copy an exact 'providerID/modelID' from opencode_list_agents (or from available_models below) instead of guessing",
                available_models: providers.flatMap((p) =>
                  Object.keys(p.models).map((m) => `${p.id}/${m}`),
                ),
              });
            }
          }
        }

        const created = await client.session.create({ body: { title: prompt.slice(0, 60) } });
        const sessionId = created.data?.id;
        if (!sessionId) {
          return jsonError({ server_id, status: "error", message: "failed to create session" });
        }

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

        const taskId = randomUUID();
        registerTask({ taskId, serverId: server_id, sessionId, createdAt: Date.now() });

        return jsonResult({
          task_id: taskId,
          server_id,
          session_id: sessionId,
          status: "pending",
        });
      } catch (error) {
        return jsonError({
          server_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

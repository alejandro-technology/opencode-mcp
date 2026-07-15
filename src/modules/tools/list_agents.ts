import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Agent, Provider } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { getServer } from "../shared/server-registry.js";

interface AgentSummary {
  name: string;
  mode: Agent["mode"];
  description?: string;
  /** Pre-assigned model as "provider/model"; can still be overridden per task. */
  model?: string;
}

// Current opencode servers report the built-in flag as `native`; the SDK types
// still declare the older `builtIn` field, so check both.
function isNativeAgent(agent: Agent): boolean {
  return (agent as Agent & { native?: boolean }).native ?? agent.builtIn ?? false;
}

function toAgentSummary(agent: Agent): AgentSummary {
  return {
    name: agent.name,
    mode: agent.mode,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.modelID}` } : {}),
  };
}

function toProviderSummary(provider: Provider) {
  return {
    provider: provider.id,
    name: provider.name,
    models: Object.keys(provider.models),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function registerOpencodeListAgents(server: McpServer) {
  server.registerTool(
    "opencode_list_agents",
    {
      description:
        "List agents (native and custom) and available models/providers on an OpenCode server instance",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to query"),
      },
    },
    async ({ server_id }) => {
      const instance = getServer(server_id);
      if (!instance) {
        return jsonError({ server_id, status: "not_found" });
      }

      try {
        const client = createOpencodeClient({ baseUrl: instance.baseUrl });
        const [agentsResult, providersResult] = await Promise.all([
          client.app.agents(),
          client.config.providers(),
        ]);

        const failure = agentsResult.error ?? providersResult.error;
        if (failure) {
          return jsonError({ server_id, status: "error", message: errorMessage(failure) });
        }

        const allAgents = agentsResult.data ?? [];
        const providers = providersResult.data?.providers ?? [];
        const defaults = providersResult.data?.default ?? {};

        return jsonResult({
          server_id,
          agents: {
            native: allAgents.filter(isNativeAgent).map(toAgentSummary),
            custom: allAgents.filter((a) => !isNativeAgent(a)).map(toAgentSummary),
          },
          models: {
            defaults,
            providers: providers.map(toProviderSummary),
          },
        });
      } catch (error) {
        return jsonError({ server_id, status: "error", message: errorMessage(error) });
      }
    },
  );
}

import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentInfo, ModelInfo, ProviderInfo } from "@opencode/client";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForServer } from "../shared/opencode-client.js";
import { getServer } from "../shared/server-registry.js";
import {
  getUsageLimits,
  type ModelQuota,
  type QuotaTier,
  quotaByModelId,
  quotaTier,
  type UsageLimits,
} from "../shared/usage-limits.js";

interface AgentSummary {
  /** CLI2 agent id is the value accepted by start_task/continue_task. */
  name: string;
  display_name: string;
  mode: AgentInfo["mode"];
  description?: string;
  model?: string;
}

// CLI2 doesn't expose agent provenance. These ids are the built-in CLI2 agent
// catalog; custom/overridden ids remain visible in the additive `all` list.
const BUILTIN_AGENT_IDS = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
]);

function toAgentSummary(agent: AgentInfo): AgentSummary {
  return {
    name: agent.id,
    display_name: agent.name,
    mode: agent.mode,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.id}` } : {}),
  };
}

interface ModelSummary {
  id: string;
  quota: { per_5h: number | null; tier: QuotaTier } | null;
}

function toProviderSummary(
  provider: ProviderInfo,
  models: ModelInfo[],
  quotas: Map<string, ModelQuota>,
) {
  return {
    provider: provider.id,
    name: provider.name,
    models: models
      .filter((model) => model.providerID === provider.id)
      .map((model) => toModelSummary(model.id, quotas.get(model.id))),
  };
}

function toModelSummary(id: string, quota: ModelQuota | undefined): ModelSummary {
  if (!quota) return { id, quota: null };
  return { id, quota: { per_5h: quota.perFiveHours, tier: quotaTier(quota.perFiveHours) } };
}

function toQuotaSnapshot(limits: UsageLimits | null) {
  if (!limits) return null;
  return { source: limits.source, checked: limits.fetchedAt.slice(0, 10) };
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
        directory: z
          .string()
          .optional()
          .describe("Project directory, relative to the server directory unless absolute"),
      },
    },
    async ({ server_id, directory }) => {
      const instance = getServer(server_id);
      if (!instance) return jsonError({ server_id, status: "not_found" });
      try {
        let projectDirectory: string;
        try {
          projectDirectory = await realpath(
            resolve(instance.directory ?? process.cwd(), directory ?? "."),
          );
          if (!(await stat(projectDirectory)).isDirectory())
            return jsonError({ server_id, status: "invalid_directory", directory });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR")
            return jsonError({ server_id, status: "invalid_directory", directory });
          throw error;
        }
        const client = clientForServer(server_id, projectDirectory);
        if (!client) return jsonError({ server_id, status: "not_found" });
        const [agentsResult, providersResult, modelsResult, defaultsResult, limits] =
          await Promise.all([
            client.agent.list({ location: { directory: projectDirectory } }),
            client.provider.list({ location: { directory: projectDirectory } }),
            client.model.list({ location: { directory: projectDirectory } }),
            client.model.default({ location: { directory: projectDirectory } }),
            getUsageLimits(),
          ]);
        const allAgents = agentsResult.data.map(toAgentSummary);
        const quotas = limits ? quotaByModelId(limits) : new Map<string, ModelQuota>();
        const providers = providersResult.data.map((provider) =>
          toProviderSummary(provider, modelsResult.data, quotas),
        );
        const native = allAgents.filter((agent) => BUILTIN_AGENT_IDS.has(agent.name));
        const custom = allAgents.filter((agent) => !BUILTIN_AGENT_IDS.has(agent.name));
        return jsonResult({
          server_id,
          directory: projectDirectory,
          agents: {
            native,
            custom,
            all: allAgents,
            classification: "builtin_ids",
          },
          models: {
            defaults: defaultsResult.data
              ? { [defaultsResult.data.providerID]: defaultsResult.data.id }
              : {},
            quota_snapshot: toQuotaSnapshot(limits),
            providers,
          },
        });
      } catch (error) {
        return jsonError({ server_id, status: "error", message: errorMessage(error) });
      }
    },
  );
}

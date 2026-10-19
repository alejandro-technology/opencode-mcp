import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Agent, Provider } from "@opencode-ai/sdk";
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

interface ModelSummary {
  /** The model id to combine with `provider` as "provider/id". */
  id: string;
  /** OpenCode Go quota for this model, or `null` when the docs list none. */
  quota: { per_5h: number | null; tier: QuotaTier } | null;
}

function toProviderSummary(provider: Provider, quotas: Map<string, ModelQuota>) {
  return {
    provider: provider.id,
    name: provider.name,
    models: Object.keys(provider.models).map((id) => toModelSummary(id, quotas.get(id))),
  };
}

function toModelSummary(id: string, quota: ModelQuota | undefined): ModelSummary {
  if (!quota) return { id, quota: null };
  return { id, quota: { per_5h: quota.perFiveHours, tier: quotaTier(quota.perFiveHours) } };
}

// Tells the caller whether a `quota: null` means "not an OpenCode Go model" or
// "we never got the table" — the two are indistinguishable per model.
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
      if (!instance) {
        return jsonError({ server_id, status: "not_found" });
      }

      try {
        let projectDirectory: string;
        try {
          projectDirectory = await realpath(
            resolve(instance.directory ?? process.cwd(), directory ?? "."),
          );
          if (!(await stat(projectDirectory)).isDirectory()) {
            return jsonError({ server_id, status: "invalid_directory", directory });
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            return jsonError({ server_id, status: "invalid_directory", directory });
          }
          throw error;
        }
        const client = clientForServer(server_id, projectDirectory);
        if (!client) return jsonError({ server_id, status: "not_found" });
        // getUsageLimits() reads a once-a-day snapshot from disk, so this adds
        // no network round-trip on a warm cache and never throws.
        const [agentsResult, providersResult, limits] = await Promise.all([
          client.app.agents(),
          client.config.providers(),
          getUsageLimits(),
        ]);

        const failure = agentsResult.error ?? providersResult.error;
        if (failure) {
          return jsonError({ server_id, status: "error", message: errorMessage(failure) });
        }

        const allAgents = agentsResult.data ?? [];
        const providers = providersResult.data?.providers ?? [];
        const defaults = providersResult.data?.default ?? {};
        const quotas = limits ? quotaByModelId(limits) : new Map<string, ModelQuota>();

        return jsonResult({
          server_id,
          directory: projectDirectory,
          agents: {
            native: allAgents.filter(isNativeAgent).map(toAgentSummary),
            custom: allAgents.filter((a) => !isNativeAgent(a)).map(toAgentSummary),
          },
          models: {
            defaults,
            quota_snapshot: toQuotaSnapshot(limits),
            providers: providers.map((provider) => toProviderSummary(provider, quotas)),
          },
        });
      } catch (error) {
        return jsonError({ server_id, status: "error", message: errorMessage(error) });
      }
    },
  );
}

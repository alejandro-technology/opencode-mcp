import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Config, createOpencodeServer } from "@opencode-ai/sdk";
import { z } from "zod";
import { stopPermissionScopesForServer } from "../shared/permission-scopes.js";
import { buildServerConfig, getExternalDirectoryPolicy } from "../shared/permissions.js";
import { registerServer } from "../shared/server-registry.js";

const DEFAULT_PORT = 4096;
/** Extra spawn time beyond the SDK's own 5s default; cold starts can be slow. */
const SPAWN_TIMEOUT_MS = 10_000;
/** How many ports in total are tried (preferred and consecutive fallbacks). */
const PORT_ATTEMPTS = 3;

export function registerOpencodeStartServer(server: McpServer) {
  server.registerTool(
    "opencode_start_server",
    {
      description:
        "Start a headless OpenCode server instance rooted in the working directory of this MCP process. For session-scoped MCP spawns that is the calling session's directory, not necessarily the repository root — read the returned 'directory' field to know the actual launch root",
      inputSchema: {
        port: z
          .number()
          .optional()
          .describe(
            "Port to bind the server on (default 4096). If it is already taken, the next port is tried automatically and the response reports the one actually bound",
          ),
        external_directory: z
          .enum(["read-only", "allow", "deny"])
          .optional()
          .describe(
            "External-directory policy override for this server instance ('read-only' permits reads outside the tree while keeping commands inside it free; 'allow' permits everything; 'deny' walls off the outside). Overrides OPENCODE_MCP_EXTERNAL_DIR and the default",
          ),
      },
    },
    async ({ port, external_directory }) => {
      try {
        const policy = external_directory ?? getExternalDirectoryPolicy();

        // The server inherits this process' cwd, so its project worktree is the
        // directory the MCP host was launched in — no cwd argument needed.
        const directory = await realpath(process.cwd());
        const { instance } = await startOnFreePort(port, () =>
          buildServerConfig(policy, { rootDirectory: directory }),
        );
        const serverId = randomUUID();

        registerServer({
          serverId,
          baseUrl: instance.url,
          directory,
          permissionPolicy: policy,
          permissionScopesEnabled: true,
          close: () => {
            stopPermissionScopesForServer(serverId);
            instance.close();
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server_id: serverId,
                baseUrl: instance.url,
                directory,
                status: "running",
                permissions: {
                  external_directory: policy,
                  auto_approved: true,
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );
}

/**
 * Spawn the server on the requested port, walking to the next one when it is
 * already in use. Nested chains hit this constantly: two MCP instances both
 * default to 4096, and the second spawn used to fail with a bare exit-code
 * error that callers had no basis to retry.
 */
async function startOnFreePort(
  requestedPort: number | undefined,
  config: () => Config,
): Promise<{ instance: { url: string; close: () => void }; port: number }> {
  const preferred = requestedPort ?? DEFAULT_PORT;
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = preferred + attempt;
    try {
      const instance = await createOpencodeServer({
        hostname: "127.0.0.1",
        port,
        timeout: SPAWN_TIMEOUT_MS,
        config: config(),
      });
      return { instance, port };
    } catch (error) {
      lastError = error;
    }
  }
  const message =
    lastError instanceof Error
      ? `${lastError.message}. Tried ports ${preferred}..${preferred + PORT_ATTEMPTS - 1} and none started; retry with a explicit free 'port' if this persists`
      : "all attempted ports failed to start an OpenCode server";
  throw lastError instanceof Error ? new Error(message) : lastError;
}

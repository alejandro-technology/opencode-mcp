import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createOpencodeServer } from "../shared/opencode-server.js";
import { stopPermissionScopesForServer } from "../shared/permission-scopes.js";
import { getExternalDirectoryPolicy } from "../shared/permissions.js";
import { registerServer } from "../shared/server-registry.js";

const DEFAULT_PORT = 4096;

export function registerOpencodeStartServer(server: McpServer) {
  server.registerTool(
    "opencode_start_server",
    {
      description: "Start a headless OpenCode server instance in the current working directory",
      inputSchema: {
        port: z.number().optional().describe("Port to bind the server on (default 4096)"),
      },
    },
    async ({ port }) => {
      let closeUnregisteredServer: (() => void) | undefined;
      try {
        const policy = getExternalDirectoryPolicy();

        // The server inherits this process' cwd, so its project worktree is the
        // directory the MCP host was launched in — no cwd argument needed.
        const instance = await createOpencodeServer({
          hostname: "127.0.0.1",
          port: port ?? DEFAULT_PORT,
        });
        closeUnregisteredServer = instance.close;
        const serverId = randomUUID();

        const directory = await realpath(process.cwd());
        registerServer({
          serverId,
          baseUrl: instance.url,
          password: instance.password,
          directory,
          permissionPolicy: policy,
          permissionScopesEnabled: true,
          close: () => {
            stopPermissionScopesForServer(serverId);
            instance.close();
          },
        });
        closeUnregisteredServer = undefined;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server_id: serverId,
                baseUrl: instance.url,
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
        closeUnregisteredServer?.();
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

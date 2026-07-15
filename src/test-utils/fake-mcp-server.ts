import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";

/** Minimal stand-in for McpServer that captures the registered tool handler. */
export function createFakeMcpServer() {
  // biome-ignore lint/suspicious/noExplicitAny: handler signature varies per tool
  let capturedHandler: ((...args: any[]) => unknown) | undefined;
  const registerTool = vi.fn((_name: string, _config: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
  });

  const server = { registerTool } as unknown as McpServer;

  return {
    server,
    registerTool,
    // biome-ignore lint/suspicious/noExplicitAny: input shape varies per tool
    getHandler: <T extends (...args: any[]) => unknown>() => {
      if (!capturedHandler) throw new Error("registerTool was not called");
      return capturedHandler as T;
    },
  };
}

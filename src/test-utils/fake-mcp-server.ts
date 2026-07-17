import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";

/** Minimal stand-in for McpServer that captures the registered tool/resource handlers. */
export function createFakeMcpServer() {
  // biome-ignore lint/suspicious/noExplicitAny: handler signature varies per tool
  let capturedHandler: ((...args: any[]) => unknown) | undefined;
  const registerTool = vi.fn((_name: string, _config: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
  });

  // biome-ignore lint/suspicious/noExplicitAny: handler signature varies per resource
  let capturedResourceHandler: ((...args: any[]) => unknown) | undefined;
  const registerResource = vi.fn(
    (
      _name: string,
      _uriOrTemplate: string,
      _config: unknown,
      handler: typeof capturedResourceHandler,
    ) => {
      capturedResourceHandler = handler;
    },
  );

  const server = { registerTool, registerResource } as unknown as McpServer;

  return {
    server,
    registerTool,
    registerResource,
    // biome-ignore lint/suspicious/noExplicitAny: input shape varies per tool
    getHandler: <T extends (...args: any[]) => unknown>() => {
      if (!capturedHandler) throw new Error("registerTool was not called");
      return capturedHandler as T;
    },
    // biome-ignore lint/suspicious/noExplicitAny: input shape varies per resource
    getResourceHandler: <T extends (...args: any[]) => unknown>() => {
      if (!capturedResourceHandler) throw new Error("registerResource was not called");
      return capturedResourceHandler as T;
    },
  };
}

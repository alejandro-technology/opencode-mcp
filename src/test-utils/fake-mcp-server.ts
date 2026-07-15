import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";

/** Minimal stand-in for McpServer that captures the registered tool/prompt handlers. */
export function createFakeMcpServer() {
  // biome-ignore lint/suspicious/noExplicitAny: handler signature varies per tool
  let capturedHandler: ((...args: any[]) => unknown) | undefined;
  const registerTool = vi.fn((_name: string, _config: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
  });

  // biome-ignore lint/suspicious/noExplicitAny: handler signature varies per prompt
  let capturedPromptHandler: ((...args: any[]) => unknown) | undefined;
  const registerPrompt = vi.fn(
    (_name: string, _config: unknown, handler: typeof capturedPromptHandler) => {
      capturedPromptHandler = handler;
    },
  );

  const server = { registerTool, registerPrompt } as unknown as McpServer;

  return {
    server,
    registerTool,
    registerPrompt,
    // biome-ignore lint/suspicious/noExplicitAny: input shape varies per tool
    getHandler: <T extends (...args: any[]) => unknown>() => {
      if (!capturedHandler) throw new Error("registerTool was not called");
      return capturedHandler as T;
    },
    // biome-ignore lint/suspicious/noExplicitAny: input shape varies per prompt
    getPromptHandler: <T extends (...args: any[]) => unknown>() => {
      if (!capturedPromptHandler) throw new Error("registerPrompt was not called");
      return capturedPromptHandler as T;
    },
  };
}

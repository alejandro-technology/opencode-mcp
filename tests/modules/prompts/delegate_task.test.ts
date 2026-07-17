import { describe, expect, it } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";
import { registerDelegateTaskPrompt } from "../../../src/modules/prompts/delegate_task.js";

describe("registerDelegateTaskPrompt", () => {
  it("registers the delegate_task prompt without an argsSchema", () => {
    const { server, registerPrompt } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);

    expect(registerPrompt).toHaveBeenCalledWith(
      "delegate_task",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );
    const config = registerPrompt.mock.calls[0][1] as Record<string, unknown>;
    expect(config).not.toHaveProperty("argsSchema");
  });

  it("returns static workflow instructions with the recommended models", () => {
    const { server, getPromptHandler } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);
    const handler = getPromptHandler<() => { messages: unknown[] }>();

    const result = handler();
    const text = (result.messages[0] as { content: { text: string } }).content.text;

    expect(result.messages).toHaveLength(1);
    expect(text).toContain("Fable 5, Opus 4.8, or GPT 5.6 Sol");
    expect(text).toContain("opencode_start_server");
    expect(text).toContain("opencode_list_agents");
    expect(text).toContain("opencode_start_task");
    expect(text).toContain("opencode_wait_for_task");
    expect(text).toContain("opencode_get_task_result");
    expect(text).toContain("opencode_get_task_status");
  });
});

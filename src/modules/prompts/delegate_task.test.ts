import { describe, expect, it } from "vitest";
import { createFakeMcpServer } from "../../test-utils/fake-mcp-server.js";
import { registerDelegateTaskPrompt } from "./delegate_task.js";

describe("registerDelegateTaskPrompt", () => {
  it("registers the delegate_task prompt", () => {
    const { server, registerPrompt } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);

    expect(registerPrompt).toHaveBeenCalledWith(
      "delegate_task",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );
  });

  it("produces a single-task workflow without agent or parallel_tasks", () => {
    const { server, getPromptHandler } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);
    const handler = getPromptHandler<(args: { task: string }) => { messages: unknown[] }>();

    const result = handler({ task: "Fix the bug" });
    const text = (result.messages[0] as { content: { text: string } }).content.text;

    expect(text).toContain("1. Fix the bug");
    expect(text).toContain("No specific agent was requested");
    expect(text).toContain('mode "all" and the single task_id');
    expect(result.messages).toHaveLength(1);
  });

  it("includes the agent instruction when agent is provided", () => {
    const { server, getPromptHandler } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);
    const handler =
      getPromptHandler<(args: { task: string; agent?: string }) => { messages: unknown[] }>();

    const result = handler({ task: "Fix the bug", agent: "build" });
    const text = (result.messages[0] as { content: { text: string } }).content.text;

    expect(text).toContain('Use the agent "build"');
  });

  it("lists all parallel tasks and mentions the 'any' wait mode", () => {
    const { server, getPromptHandler } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);
    const handler =
      getPromptHandler<
        (args: { task: string; parallel_tasks?: string }) => { messages: unknown[] }
      >();

    const result = handler({
      task: "Fix the bug",
      parallel_tasks: "Write tests, Update docs",
    });
    const text = (result.messages[0] as { content: { text: string } }).content.text;

    expect(text).toContain("1. Fix the bug");
    expect(text).toContain("2. Write tests");
    expect(text).toContain("3. Update docs");
    expect(text).toContain('mode "any"');
  });

  it("filters out empty entries from parallel_tasks", () => {
    const { server, getPromptHandler } = createFakeMcpServer();
    registerDelegateTaskPrompt(server);
    const handler =
      getPromptHandler<
        (args: { task: string; parallel_tasks?: string }) => { messages: unknown[] }
      >();

    const result = handler({ task: "Fix the bug", parallel_tasks: "Write tests,,  " });
    const text = (result.messages[0] as { content: { text: string } }).content.text;
    const taskListBlock = text.split("Workflow:")[0];

    expect(taskListBlock).toContain("1. Fix the bug");
    expect(taskListBlock).toContain("2. Write tests");
    expect(taskListBlock).not.toContain("3.");
  });
});

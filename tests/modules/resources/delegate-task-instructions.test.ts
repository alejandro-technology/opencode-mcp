import { describe, expect, it } from "vitest";
import { registerDelegateTaskResource } from "../../../src/modules/resources/delegate-task-instructions.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

describe("registerDelegateTaskResource", () => {
  it("registers the delegate-task-instructions resource with correct metadata", () => {
    const { server, registerResource } = createFakeMcpServer();
    registerDelegateTaskResource(server);

    expect(registerResource).toHaveBeenCalledWith(
      "delegate-task-instructions",
      "opencode://instructions/delegate-task",
      expect.objectContaining({
        title: "Delegate task to OpenCode",
        description: expect.any(String),
        mimeType: "text/plain",
      }),
      expect.any(Function),
    );
  });

  it("returns workflow instructions with the model selection guide", () => {
    const { server, getResourceHandler } = createFakeMcpServer();
    registerDelegateTaskResource(server);
    const handler =
      getResourceHandler<() => { contents: { uri: string; text: string; mimeType: string }[] }>();

    const result = handler();

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe("opencode://instructions/delegate-task");
    expect(result.contents[0].mimeType).toBe("text/plain");

    const text = result.contents[0].text;
    expect(text).toContain("Model selection guide");
    expect(text).toContain("Frontier tier");
    expect(text).toContain("Fast tier");
    expect(text).toContain("opencode_start_server");
    expect(text).toContain("opencode_list_agents");
    expect(text).toContain("opencode_start_task");
    expect(text).toContain("opencode_wait_for_task");
    expect(text).toContain("opencode_get_task_result");
    expect(text).toContain("opencode_get_task_status");
  });
});

import { describe, expect, it } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";
import { registerPrompts } from "../../../src/modules/prompts/index.js";

describe("registerPrompts", () => {
  it("registers all prompts on the server", () => {
    const { server, registerPrompt } = createFakeMcpServer();
    registerPrompts(server);

    expect(registerPrompt).toHaveBeenCalledWith(
      "delegate_task",
      expect.anything(),
      expect.any(Function),
    );
  });
});

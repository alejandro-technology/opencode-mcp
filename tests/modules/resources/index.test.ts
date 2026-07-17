import { describe, expect, it } from "vitest";
import { registerResources } from "../../../src/modules/resources/index.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

describe("registerResources", () => {
  it("registers all resources on the server", () => {
    const { server, registerResource } = createFakeMcpServer();
    registerResources(server);

    expect(registerResource).toHaveBeenCalledWith(
      "delegate-task-instructions",
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
  });
});

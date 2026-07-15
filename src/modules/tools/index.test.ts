import { describe, expect, it } from "vitest";
import { createFakeMcpServer } from "../../test-utils/fake-mcp-server.js";
import { registerTools } from "./index.js";

describe("registerTools", () => {
  it("registers every opencode tool", () => {
    const fake = createFakeMcpServer();

    registerTools(fake.server);

    const names = fake.registerTool.mock.calls.map((call) => call[0]);
    expect(names).toEqual([
      "opencode_start_server",
      "opencode_stop_server",
      "opencode_list_agents",
      "opencode_start_task",
      "opencode_get_task_status",
      "opencode_get_task_result",
      "opencode_wait_for_task",
    ]);
  });
});

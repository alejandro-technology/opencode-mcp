import { describe, expect, it } from "vitest";
import { DELEGATE_TASK_INSTRUCTIONS } from "../../../src/modules/shared/instructions.js";

describe("DELEGATE_TASK_INSTRUCTIONS", () => {
  it("tells the agent to copy model ids verbatim instead of guessing", () => {
    expect(DELEGATE_TASK_INSTRUCTIONS).toContain(
      "copy the exact provider id and model id verbatim",
    );
    expect(DELEGATE_TASK_INSTRUCTIONS).toContain("unknown_model");
    expect(DELEGATE_TASK_INSTRUCTIONS).toContain("opencode_list_agents");
  });
});

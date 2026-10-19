import { describe, expect, it, vi } from "vitest";

describe("createMessageId", () => {
  it("uses the OpenCode message namespace", async () => {
    vi.doMock("node:crypto", () => ({ randomUUID: () => "run-uuid" }));
    vi.resetModules();
    const { createMessageId } = await import("../../../src/modules/shared/message-id.js");
    expect(createMessageId()).toBe("msg_run-uuid");
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });
});

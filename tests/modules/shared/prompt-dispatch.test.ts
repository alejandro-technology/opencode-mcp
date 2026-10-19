import { describe, expect, it } from "vitest";
import { sendPromptAndClassify } from "../../../src/modules/shared/prompt-dispatch.js";

describe("sendPromptAndClassify", () => {
  it("recognizes accepted responses and definite client rejection", async () => {
    await expect(sendPromptAndClassify(async () => ({ data: {} }))).resolves.toEqual({
      state: "accepted",
    });
    await expect(
      sendPromptAndClassify(async () => ({
        error: { message: "invalid prompt" },
        response: { status: 422 },
      })),
    ).resolves.toEqual({ state: "rejected", status: 422, error: "invalid prompt" });
  });

  it("keeps server failures without a definite rejection status uncertain", async () => {
    await expect(
      sendPromptAndClassify(async () => ({
        error: { message: "server error" },
        response: { status: 503 },
      })),
    ).resolves.toEqual({ state: "uncertain", status: 503, error: "server error" });
    await expect(sendPromptAndClassify(async () => ({ error: "raw error" }))).resolves.toEqual({
      state: "uncertain",
      error: "raw error",
    });
    await expect(
      sendPromptAndClassify(async () => ({
        error: "malformed response",
        response: "not an HTTP response",
      })),
    ).resolves.toEqual({ state: "uncertain", error: "malformed response" });
    await expect(
      sendPromptAndClassify(async () => ({
        error: "non-numeric status",
        response: { status: "503" },
      })),
    ).resolves.toEqual({ state: "uncertain", error: "non-numeric status" });
  });

  it("retains ambiguity for transport throws, including non-Error values", async () => {
    await expect(
      sendPromptAndClassify(async () => {
        throw new Error("connection reset");
      }),
    ).resolves.toEqual({
      state: "uncertain",
      error: "connection reset",
    });
    await expect(
      sendPromptAndClassify(async () => {
        throw "raw transport failure";
      }),
    ).resolves.toEqual({
      state: "uncertain",
      error: "raw transport failure",
    });
  });
});

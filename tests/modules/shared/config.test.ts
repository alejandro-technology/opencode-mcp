import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMaxToolTimeoutMs } from "../../../src/modules/shared/config.js";

const originalArgv = [...process.argv];

describe("getMaxToolTimeoutMs", () => {
  beforeEach(() => {
    delete process.env.MCP_TOOL_TIMEOUT;
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    delete process.env.MCP_TOOL_TIMEOUT;
    process.argv = [...originalArgv];
  });

  it("falls back to the default (300000) when nothing is set", () => {
    expect(getMaxToolTimeoutMs()).toBe(300_000);
  });

  it("reads the value from the MCP_TOOL_TIMEOUT env var", () => {
    process.env.MCP_TOOL_TIMEOUT = "1200000";
    expect(getMaxToolTimeoutMs()).toBe(1_200_000);
  });

  it("reads the value from an MCP_TOOL_TIMEOUT=<ms> argv entry", () => {
    process.argv = [...originalArgv, "MCP_TOOL_TIMEOUT=45000"];
    expect(getMaxToolTimeoutMs()).toBe(45_000);
  });

  it("prefers the env var over argv when both are present", () => {
    process.env.MCP_TOOL_TIMEOUT = "1200000";
    process.argv = [...originalArgv, "MCP_TOOL_TIMEOUT=45000"];
    expect(getMaxToolTimeoutMs()).toBe(1_200_000);
  });

  it("falls back to the default for a non-numeric env var", () => {
    process.env.MCP_TOOL_TIMEOUT = "not-a-number";
    expect(getMaxToolTimeoutMs()).toBe(300_000);
  });

  it("falls back to the default for a non-positive env var", () => {
    process.env.MCP_TOOL_TIMEOUT = "-5";
    expect(getMaxToolTimeoutMs()).toBe(300_000);
  });

  it("falls back to the default for a non-numeric argv value", () => {
    process.argv = [...originalArgv, "MCP_TOOL_TIMEOUT=nope"];
    expect(getMaxToolTimeoutMs()).toBe(300_000);
  });

  it("falls back to the default when the env var is an empty string", () => {
    process.env.MCP_TOOL_TIMEOUT = "";
    expect(getMaxToolTimeoutMs()).toBe(300_000);
  });
});

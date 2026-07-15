import { describe, expect, it } from "vitest";
import { jsonError, jsonResult } from "./mcp-result.js";

describe("jsonResult", () => {
  it("wraps a payload as a text content block", () => {
    const result = jsonResult({ foo: "bar" });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ foo: "bar" }) }],
    });
  });
});

describe("jsonError", () => {
  it("wraps a payload as an error text content block", () => {
    const result = jsonError({ foo: "bar" });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ foo: "bar" }) }],
    });
  });
});

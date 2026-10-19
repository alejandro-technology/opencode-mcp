import { describe, expect, it } from "vitest";
import { buildExecutionUsage } from "../../../src/modules/shared/execution-usage.js";
import type { AssistantEntry } from "../../../src/modules/shared/opencode-client.js";

function entry(
  id: string,
  parentID: string,
  providerID: string,
  modelID: string,
  values: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    read?: unknown;
    write?: unknown;
    cost?: unknown;
  } = {},
  parts: AssistantEntry["parts"] = [],
): AssistantEntry {
  return {
    info: {
      id,
      parentID,
      providerID,
      modelID,
      tokens: {
        input: values.input,
        output: values.output,
        reasoning: values.reasoning,
        cache: { read: values.read, write: values.write },
      },
      cost: values.cost,
    } as unknown as AssistantEntry["info"],
    parts,
  };
}

describe("buildExecutionUsage", () => {
  it("separates current-run usage from cumulative session usage across continuation and same-parent messages", () => {
    const report = buildExecutionUsage(
      [
        entry("a", "user-1", "p", "m", {
          input: 2,
          output: 1,
          reasoning: 3,
          read: 4,
          write: 5,
          cost: 0.000001,
        }),
        entry("b", "user-1", "p", "m", {
          input: 7,
          output: 6,
          reasoning: 8,
          read: 9,
          write: 10,
          cost: 0.000002,
        }),
        entry("c", "user-2", "q", "n", {
          input: 11,
          output: 12,
          reasoning: 13,
          read: 14,
          write: 15,
          cost: 0.000003,
        }),
      ],
      "user-1",
    );
    expect(report.run?.message_count).toBe(2);
    expect(report.run?.input.value).toBe(9);
    expect(report.session.message_count).toBe(3);
    expect(report.session.input.value).toBe(20);
    expect(report.session.reported_cost.value).toBe(0.000006);
    expect(
      report.session.breakdown.map(({ provider_id, model_id }) => [provider_id, model_id]),
    ).toEqual([
      ["p", "m"],
      ["q", "n"],
    ]);
    expect(report.currency).toBeNull();
    expect(report.scope.descendants_included).toBe(false);
    expect(report.scope.subagent_sessions_included).toBe(false);
  });

  it("uses the latest occurrence for duplicate IDs and treats explicit zero as known", () => {
    const report = buildExecutionUsage(
      [
        entry("same", "user", "p", "m", {
          input: 4,
          output: 3,
          reasoning: 2,
          read: 1,
          write: 9,
          cost: 2,
        }),
        entry("same", "user", "p", "m", {
          input: 0,
          output: 0,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 0,
        }),
      ],
      "user",
    );
    expect(report.session.message_count).toBe(1);
    expect(report.session.input).toEqual({ value: 0, complete: true, missing_messages: 0 });
    expect(report.session.reported_cost).toEqual({ value: 0, complete: true, missing_messages: 0 });
  });

  it("keeps absent, invalid, and negative metrics unknown without throwing", () => {
    const report = buildExecutionUsage(
      [
        entry("partial", "user", "p", "m", {
          input: Number.NaN,
          output: -1,
          reasoning: Infinity,
          read: "4",
          cost: -0.2,
        }),
        { info: { id: "old" } as unknown as AssistantEntry["info"], parts: [] },
      ],
      "user",
    );
    expect(report.session.input).toEqual({ value: null, complete: false, missing_messages: 2 });
    expect(report.session.output).toEqual({ value: null, complete: false, missing_messages: 2 });
    expect(report.session.reasoning).toEqual({ value: null, complete: false, missing_messages: 2 });
    expect(report.session.cache_read).toEqual({
      value: null,
      complete: false,
      missing_messages: 2,
    });
    expect(report.session.reported_cost).toEqual({
      value: null,
      complete: false,
      missing_messages: 2,
    });
    expect(report.session.message_count).toBe(2);
    expect(report.run?.message_count).toBe(1);
  });

  it("updates anonymous in-progress entries without treating them as the same message", () => {
    const first = entry("", "u", "p", "m", { input: 1 });
    const second = entry("", "u", "p", "m", { input: 2 });
    const report = buildExecutionUsage([first, second], "u");
    expect(report.session.message_count).toBe(2);
    expect(report.session.input.value).toBe(3);
  });

  it("keeps cache and reasoning separate and ignores step-finish costs in parts", () => {
    const report = buildExecutionUsage(
      [
        entry("one", "u", "p", "m", { input: 10, reasoning: 2, read: 3, write: 4, cost: 0.01 }, [
          { type: "step-finish", cost: 100, tokens: { input: 500, output: 600 } } as never,
        ]),
      ],
      "u",
    );
    expect(report.session.reasoning.value).toBe(2);
    expect(report.session.cache_read.value).toBe(3);
    expect(report.session.cache_write.value).toBe(4);
    expect(report.session.input.value).toBe(10);
    expect(report.session.reported_cost.value).toBe(0.01);
  });

  it("returns null run without a selector and unknown consumption for empty snapshots", () => {
    const report = buildExecutionUsage([]);
    expect(report.run).toBeNull();
    expect(report.session.message_count).toBe(0);
    expect(report.session.input).toEqual({ value: null, complete: false, missing_messages: 0 });
    expect(report.session.reported_cost).toEqual({
      value: null,
      complete: false,
      missing_messages: 0,
    });
    expect(buildExecutionUsage([], "user").run?.message_count).toBe(0);
  });

  it("handles malformed token containers and non-string run selectors", () => {
    const malformed = entry("malformed", "u", "", "", { input: 0 });
    (malformed.info as unknown as { tokens: unknown }).tokens = null;
    const report = buildExecutionUsage([malformed], null);
    expect(report.run).toBeNull();
    expect(report.session.breakdown[0]).toMatchObject({ provider_id: null, model_id: null });
    expect(report.session.input.value).toBeNull();
  });

  it("preserves unknown totals when later entries are known and rejects malformed cache objects", () => {
    const missing = {
      info: { id: "missing", tokens: {} } as unknown as AssistantEntry["info"],
      parts: [],
    };
    const later = entry("later", "u", "p", "m", { input: 2, output: 0, reasoning: 0, cost: 0 });
    (later.info as unknown as { tokens: { cache: unknown } }).tokens.cache = "invalid";
    const report = buildExecutionUsage([missing, later]);
    expect(report.session.input.value).toBeNull();
    expect(report.session.cache_read.value).toBeNull();
    expect(report.session.cache_write.value).toBeNull();
  });
});

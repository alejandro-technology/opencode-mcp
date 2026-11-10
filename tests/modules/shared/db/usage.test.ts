import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRawDb, resetDbForTests } from "../../../../src/modules/shared/db/index.js";
import {
  getRollingUsageSummary,
  upsertUsageLedger,
} from "../../../../src/modules/shared/db/usage.js";
import type { UsageBreakdown } from "../../../../src/modules/shared/execution-usage.js";

const ORIGINAL_DB_ENV = process.env.OPENCODE_MCP_HISTORY_DB;

let root: string;

function metric(value: number | null) {
  return { value, complete: value !== null, missing_messages: value === null ? 1 : 0 };
}

function breakdown(
  providerId: string | null,
  modelId: string | null,
  messageCount: number,
  values: Partial<
    Record<keyof Omit<UsageBreakdown, "provider_id" | "model_id" | "message_count">, number | null>
  > = {},
): UsageBreakdown {
  return {
    provider_id: providerId,
    model_id: modelId,
    message_count: messageCount,
    input: metric(values.input ?? null),
    output: metric(values.output ?? null),
    reasoning: metric(values.reasoning ?? null),
    cache_read: metric(values.cache_read ?? null),
    cache_write: metric(values.cache_write ?? null),
    reported_cost: metric(values.reported_cost ?? null),
  };
}

beforeEach(() => {
  resetDbForTests();
  root = mkdtempSync(join(tmpdir(), "opencode-mcp-usage-db-"));
  process.env.OPENCODE_MCP_HISTORY_DB = join(root, "history.sqlite");
});

afterEach(() => {
  resetDbForTests();
  if (ORIGINAL_DB_ENV === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
  else process.env.OPENCODE_MCP_HISTORY_DB = ORIGINAL_DB_ENV;
  rmSync(root, { recursive: true, force: true });
});

describe("upsertUsageLedger", () => {
  it("inserts a complete run and updates it in place on conflict", () => {
    upsertUsageLedger({
      runId: "run-1",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: 1_000,
      messageCount: 2,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cacheRead: 2,
      cacheWrite: 3,
      reportedCost: 0.5,
      complete: true,
      breakdown: [breakdown("p", "m", 2, { input: 10, output: 5 })],
    });

    upsertUsageLedger({
      runId: "run-1",
      taskId: "task-2",
      sessionId: "ses-2",
      capturedAt: 2_000,
      messageCount: 4,
      inputTokens: 20,
      outputTokens: 6,
      reasoningTokens: 2,
      cacheRead: 4,
      cacheWrite: 5,
      reportedCost: 0.75,
      complete: false,
      breakdown: [breakdown("p", "m", 4, { input: 20, output: 6 })],
    });

    const rows = getRawDb()
      .prepare("SELECT * FROM usage_ledger WHERE run_id = ?")
      .all("run-1") as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: "run-1",
      task_id: "task-2",
      session_id: "ses-2",
      captured_at: 2_000,
      message_count: 4,
      input_tokens: 20,
      output_tokens: 6,
      reasoning_tokens: 2,
      cache_read: 4,
      cache_write: 5,
      reported_cost: 0.75,
      complete: 0,
    });
    expect(JSON.parse(rows[0].breakdown as string)).toEqual([
      breakdown("p", "m", 4, { input: 20, output: 6 }),
    ]);
  });

  it("stores missing metrics and an absent breakdown as null", () => {
    upsertUsageLedger({
      runId: "run-missing",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: 1_000,
      messageCount: 0,
      complete: false,
    });

    const row = getRawDb()
      .prepare("SELECT * FROM usage_ledger WHERE run_id = ?")
      .get("run-missing") as Record<string, unknown>;

    expect(row).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read: null,
      cache_write: null,
      reported_cost: null,
      breakdown: null,
      complete: 0,
    });
  });
});

describe("getRollingUsageSummary", () => {
  it("returns an empty, explicitly incomplete summary when nothing is recorded", () => {
    const summary = getRollingUsageSummary(5 * 3600 * 1000);

    expect(summary).toMatchObject({
      ledger_runs: 0,
      message_count: 0,
      breakdown: [],
    });
    for (const key of [
      "input",
      "output",
      "reasoning",
      "cache_read",
      "cache_write",
      "reported_cost",
    ] as const) {
      expect(summary[key]).toEqual({ value: null, complete: false, missing_messages: 0 });
    }
  });

  it("separates the 5h window from 7d and keeps unknown metrics null", () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600 * 1000;
    const threeHoursAgo = now - 3 * 3600 * 1000;
    const eightHoursAgo = now - 8 * 3600 * 1000;

    upsertUsageLedger({
      runId: "run-b",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: threeHoursAgo,
      messageCount: 3,
      inputTokens: 5,
      outputTokens: null,
      reasoningTokens: 2,
      cacheRead: 1,
      cacheWrite: null,
      reportedCost: null,
      complete: false,
      breakdown: [breakdown("p", "m", 3, { input: 5, output: null })],
    });
    upsertUsageLedger({
      runId: "run-a",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: twoHoursAgo,
      messageCount: 2,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 1,
      cacheRead: 2,
      cacheWrite: 3,
      reportedCost: 0.1,
      complete: true,
      breakdown: [
        breakdown("p", "m", 2, {
          input: 10,
          output: 4,
          reasoning: 1,
          cache_read: 2,
          cache_write: 3,
          reported_cost: 0.1,
        }),
        breakdown("p", "n", 1, { input: 7, output: 1 }),
      ],
    });
    upsertUsageLedger({
      runId: "run-old",
      taskId: "task-1",
      sessionId: "ses-1",
      capturedAt: eightHoursAgo,
      messageCount: 9,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 25,
      cacheRead: 10,
      cacheWrite: 5,
      reportedCost: 1,
      complete: true,
      breakdown: null,
    });

    const fiveHours = getRollingUsageSummary(5 * 3600 * 1000);
    expect(fiveHours).toMatchObject({
      ledger_runs: 2,
      message_count: 5,
    });
    expect(fiveHours.input).toEqual({ value: 15, complete: true, missing_messages: 0 });
    expect(fiveHours.output).toEqual({ value: null, complete: false, missing_messages: 1 });
    expect(fiveHours.reasoning).toEqual({ value: 3, complete: true, missing_messages: 0 });
    expect(fiveHours.cache_read).toEqual({ value: 3, complete: true, missing_messages: 0 });
    expect(fiveHours.cache_write).toEqual({
      value: null,
      complete: false,
      missing_messages: 1,
    });
    expect(fiveHours.reported_cost).toEqual({
      value: null,
      complete: false,
      missing_messages: 1,
    });

    expect(fiveHours.breakdown).toHaveLength(2);
    expect(fiveHours.breakdown[0]).toMatchObject({
      provider_id: "p",
      model_id: "m",
      message_count: 5,
    });
    expect(fiveHours.breakdown[0].input).toEqual({
      value: 15,
      complete: true,
      missing_messages: 0,
    });
    expect(fiveHours.breakdown[0].reported_cost).toEqual({
      value: null,
      complete: false,
      missing_messages: 1,
    });
    expect(fiveHours.breakdown[1]).toMatchObject({
      provider_id: "p",
      model_id: "n",
      message_count: 1,
    });

    const sevenDays = getRollingUsageSummary(7 * 24 * 3600 * 1000);
    expect(sevenDays).toMatchObject({
      ledger_runs: 3,
      message_count: 14,
    });
    expect(sevenDays.input).toEqual({ value: 115, complete: true, missing_messages: 0 });
    expect(sevenDays.output).toEqual({ value: null, complete: false, missing_messages: 1 });
    expect(sevenDays.breakdown).toHaveLength(2);
    expect(sevenDays.breakdown[0].message_count).toBe(5);
  });
});

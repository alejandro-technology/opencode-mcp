import { gte } from "drizzle-orm";
import type { UsageBreakdown, UsageMetric } from "../execution-usage.js";
import { getDb } from "./index.js";
import { type UsageLedgerRow, usageLedger } from "./schema.js";

export type UsageLedgerEntry = {
  runId: string;
  taskId: string;
  sessionId: string;
  capturedAt: number;
  messageCount: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  reportedCost?: number | null;
  complete: boolean;
  breakdown?: UsageBreakdown[] | null;
};

export type RollingUsageModel = {
  provider_id: string | null;
  model_id: string | null;
  message_count: number;
  input: UsageMetric;
  output: UsageMetric;
  reasoning: UsageMetric;
  cache_read: UsageMetric;
  cache_write: UsageMetric;
  reported_cost: UsageMetric;
};

export type RollingUsageSummary = {
  window_ms: number;
  captured_at_or_after: number;
  ledger_runs: number;
  message_count: number;
  input: UsageMetric;
  output: UsageMetric;
  reasoning: UsageMetric;
  cache_read: UsageMetric;
  cache_write: UsageMetric;
  reported_cost: UsageMetric;
  breakdown: RollingUsageModel[];
};

type MetricKey = "input" | "output" | "reasoning" | "cache_read" | "cache_write" | "reported_cost";

const METRICS: readonly MetricKey[] = [
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "reported_cost",
];

export function upsertUsageLedger(entry: UsageLedgerEntry): void {
  const inputTokens = entry.inputTokens ?? null;
  const outputTokens = entry.outputTokens ?? null;
  const reasoningTokens = entry.reasoningTokens ?? null;
  const cacheRead = entry.cacheRead ?? null;
  const cacheWrite = entry.cacheWrite ?? null;
  const reportedCost = entry.reportedCost ?? null;
  const breakdown = entry.breakdown ?? null;

  getDb()
    .insert(usageLedger)
    .values({
      runId: entry.runId,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      capturedAt: entry.capturedAt,
      messageCount: entry.messageCount,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheRead,
      cacheWrite,
      reportedCost,
      complete: entry.complete,
      breakdown,
    })
    .onConflictDoUpdate({
      target: usageLedger.runId,
      set: {
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        capturedAt: entry.capturedAt,
        messageCount: entry.messageCount,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheRead,
        cacheWrite,
        reportedCost,
        complete: entry.complete,
        breakdown,
      },
    })
    .run();
}

export function getRollingUsageSummary(windowMs: number): RollingUsageSummary {
  const capturedAtOrAfter = Date.now() - windowMs;
  const rows = getDb()
    .select()
    .from(usageLedger)
    .where(gte(usageLedger.capturedAt, capturedAtOrAfter))
    .all();

  return {
    window_ms: windowMs,
    captured_at_or_after: capturedAtOrAfter,
    ledger_runs: rows.length,
    message_count: rows.reduce((total, row) => total + row.messageCount, 0),
    input: aggregateMetric(rows.map((row) => rowMetric(row, "input"))),
    output: aggregateMetric(rows.map((row) => rowMetric(row, "output"))),
    reasoning: aggregateMetric(rows.map((row) => rowMetric(row, "reasoning"))),
    cache_read: aggregateMetric(rows.map((row) => rowMetric(row, "cache_read"))),
    cache_write: aggregateMetric(rows.map((row) => rowMetric(row, "cache_write"))),
    reported_cost: aggregateMetric(rows.map((row) => rowMetric(row, "reported_cost"))),
    breakdown: aggregateBreakdown(rows),
  };
}

function rowMetric(row: UsageLedgerRow, key: MetricKey): number | null {
  switch (key) {
    case "input":
      return row.inputTokens;
    case "output":
      return row.outputTokens;
    case "reasoning":
      return row.reasoningTokens;
    case "cache_read":
      return row.cacheRead;
    case "cache_write":
      return row.cacheWrite;
    case "reported_cost":
      return row.reportedCost;
  }
}

function aggregateMetric(values: Array<number | null>): UsageMetric {
  let value: number | null = values.length === 0 ? null : 0;
  let missing = 0;
  for (const item of values) {
    if (item === null) {
      missing += 1;
      value = null;
    } else if (value !== null) {
      value += item;
    }
  }
  return { value, complete: missing === 0 && values.length > 0, missing_messages: missing };
}

type ModelAccumulator = {
  provider_id: string | null;
  model_id: string | null;
  message_count: number;
  values: Record<MetricKey, Array<number | null>>;
};

function emptyMetricValues(): Record<MetricKey, Array<number | null>> {
  return {
    input: [],
    output: [],
    reasoning: [],
    cache_read: [],
    cache_write: [],
    reported_cost: [],
  };
}

function aggregateBreakdown(rows: UsageLedgerRow[]): RollingUsageModel[] {
  const groups = new Map<string, ModelAccumulator>();

  for (const row of rows) {
    for (const item of row.breakdown ?? []) {
      const key = JSON.stringify([item.provider_id, item.model_id]);
      let group = groups.get(key);
      if (!group) {
        group = {
          provider_id: item.provider_id,
          model_id: item.model_id,
          message_count: 0,
          values: emptyMetricValues(),
        };
        groups.set(key, group);
      }
      group.message_count += item.message_count;
      for (const metric of METRICS) group.values[metric].push(item[metric].value);
    }
  }

  return [...groups.values()].map((group) => ({
    provider_id: group.provider_id,
    model_id: group.model_id,
    message_count: group.message_count,
    input: aggregateMetric(group.values.input),
    output: aggregateMetric(group.values.output),
    reasoning: aggregateMetric(group.values.reasoning),
    cache_read: aggregateMetric(group.values.cache_read),
    cache_write: aggregateMetric(group.values.cache_write),
    reported_cost: aggregateMetric(group.values.reported_cost),
  }));
}

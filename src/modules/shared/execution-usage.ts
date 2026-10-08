import type { AssistantEntry } from "./opencode-client.js";

export type UsageMetricName =
  | "input"
  | "output"
  | "reasoning"
  | "cache_read"
  | "cache_write"
  | "reported_cost";

export type UsageMetric = {
  value: number | null;
  complete: boolean;
  missing_messages: number;
};

export type UsageBreakdown = {
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

export type UsageSummary = {
  message_count: number;
  input: UsageMetric;
  output: UsageMetric;
  reasoning: UsageMetric;
  cache_read: UsageMetric;
  cache_write: UsageMetric;
  reported_cost: UsageMetric;
  breakdown: UsageBreakdown[];
};

export type ExecutionUsageReport = {
  currency: null;
  cost_label: "reported_by_opencode_not_invoiced_cost";
  scope: {
    session_messages: "all_direct_assistant_messages_passed";
    run_messages: "direct_assistant_messages_parented_to_current_user_message";
    descendants_included: false;
    subagent_sessions_included: false;
  };
  run: UsageSummary | null;
  session: UsageSummary;
};

export type ExecutionUsageSnapshot = {
  captured_at: string;
  snapshot_kind: "live_observation" | "run_finalization";
  /** Null when the SDK message snapshot could not be fetched. */
  report: ExecutionUsageReport | null;
  diagnostic?: string;
};

type MetricKey = "input" | "output" | "reasoning" | "cache_read" | "cache_write" | "reported_cost";
type MessageInfo = AssistantEntry["info"] & {
  parentID?: unknown;
  id?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  cost?: unknown;
  tokens?: unknown;
};

const METRICS: readonly MetricKey[] = [
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "reported_cost",
];

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function metric(values: Array<number | null>): UsageMetric {
  let value: number | null = values.length === 0 ? null : 0;
  let missingMessages = 0;
  for (const item of values) {
    if (item === null) {
      missingMessages += 1;
      value = null;
    } else if (value !== null) {
      value += item;
    }
  }
  return {
    value,
    complete: missingMessages === 0 && values.length > 0,
    missing_messages: missingMessages,
  };
}

function metricValue(info: MessageInfo, key: MetricKey): number | null {
  if (key === "reported_cost") return finiteMetric(info.cost);
  const tokens = info.tokens;
  if (typeof tokens !== "object" || tokens === null) return null;
  const tokenFields = tokens as Record<string, unknown>;
  if (key === "cache_read" || key === "cache_write") {
    const cache = tokenFields.cache;
    return typeof cache === "object" && cache !== null
      ? finiteMetric((cache as Record<string, unknown>)[key === "cache_read" ? "read" : "write"])
      : null;
  }
  return finiteMetric(tokenFields[key]);
}

function summarize(entries: AssistantEntry[]): UsageSummary {
  const unique = new Map<string, MessageInfo>();
  let anonymousIndex = 0;
  for (const entry of entries) {
    const info = entry.info as MessageInfo;
    const id =
      typeof info.id === "string" && info.id.length > 0
        ? info.id
        : `__anonymous_${anonymousIndex++}`;
    unique.set(id, info);
  }
  const messages = [...unique.values()];
  const makeMetrics = (items: MessageInfo[]) =>
    Object.fromEntries(
      METRICS.map((key) => [key, metric(items.map((item) => metricValue(item, key)))]),
    ) as Pick<UsageSummary, MetricKey>;
  const groups = new Map<string, MessageInfo[]>();
  for (const item of messages) {
    const provider =
      typeof item.providerID === "string" && item.providerID ? item.providerID : null;
    const model = typeof item.modelID === "string" && item.modelID ? item.modelID : null;
    const key = JSON.stringify([provider, model]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const breakdown: UsageBreakdown[] = [...groups.entries()].map(([key, items]) => {
    const [provider_id, model_id] = JSON.parse(key) as [string | null, string | null];
    return { provider_id, model_id, message_count: items.length, ...makeMetrics(items) };
  });
  return { message_count: messages.length, ...makeMetrics(messages), breakdown };
}

/** Aggregate only direct assistant-message INFO metrics; parts are deliberately ignored. */
export function buildExecutionUsage(
  entries: AssistantEntry[],
  currentMessageID?: string | null,
): ExecutionUsageReport {
  const session = summarize(entries);
  const run =
    typeof currentMessageID === "string"
      ? summarize(
          entries.filter((entry) => (entry.info as MessageInfo).parentID === currentMessageID),
        )
      : null;
  return {
    currency: null,
    cost_label: "reported_by_opencode_not_invoiced_cost",
    scope: {
      session_messages: "all_direct_assistant_messages_passed",
      run_messages: "direct_assistant_messages_parented_to_current_user_message",
      descendants_included: false,
      subagent_sessions_included: false,
    },
    run,
    session,
  };
}

import type { InferSelectModel } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ExecutionReport, ExpectedChange, VerificationCheck } from "../execution-report.js";
import type { ExecutionUsageSnapshot, UsageBreakdown } from "../execution-usage.js";
import type { CachedTaskResult } from "../task-registry.js";
import type { ModelQuota, SpendBudget } from "../usage-limits.js";
import type { WorkspaceMetadata } from "../workspace-manager.js";

export const mcpInstances = sqliteTable("mcp_instances", {
  instanceId: text("instance_id").primaryKey(),
  pid: integer("pid").notNull(),
  processStartedAt: integer("process_started_at").notNull(),
  heartbeatAt: integer("heartbeat_at").notNull(),
  stoppedAt: integer("stopped_at"),
  version: text("version").notNull(),
});

export const servers = sqliteTable("servers", {
  serverId: text("server_id").primaryKey(),
  ownerInstanceId: text("owner_instance_id").notNull(),
  baseUrl: text("base_url").notNull(),
  directory: text("directory").notNull(),
  permissionPolicy: text("permission_policy", {
    enum: ["read-only", "allow", "deny"],
  }).notNull(),
  startedAt: integer("started_at").notNull(),
  stoppedAt: integer("stopped_at"),
});

export const workspaces = sqliteTable("workspaces", {
  workspaceId: text("workspace_id").primaryKey(),
  serverId: text("server_id").notNull(),
  sourceDirectory: text("source_directory").notNull(),
  repositoryDirectory: text("repository_directory").notNull(),
  worktreeDirectory: text("worktree_directory").notNull(),
  executionDirectory: text("execution_directory").notNull(),
  baseCommit: text("base_commit").notNull(),
  sourceDirty: integer("source_dirty", { mode: "boolean" }).notNull(),
  state: text("state", { enum: ["active", "cleaning", "removed"] }).notNull(),
  ownerInstanceId: text("owner_instance_id").notNull(),
  createdAt: integer("created_at").notNull(),
  removedAt: integer("removed_at"),
});

export const tasks = sqliteTable("tasks", {
  taskId: text("task_id").primaryKey(),
  serverId: text("server_id").notNull(),
  sessionId: text("session_id").notNull(),
  directory: text("directory"),
  workspaceId: text("workspace_id"),
  workspaceMetadata: text("workspace_metadata", { mode: "json" }).$type<WorkspaceMetadata>(),
  currentRunId: text("current_run_id"),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at").notNull(),
  cancelledAt: integer("cancelled_at"),
});

export const taskRuns = sqliteTable("task_runs", {
  runId: text("run_id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.taskId, { onDelete: "cascade" }),
  messageId: text("message_id").notNull().unique(),
  agentName: text("agent_name"),
  requestedProviderId: text("requested_provider_id"),
  requestedModelId: text("requested_model_id"),
  startedAt: integer("started_at").notNull(),
  cancelledAt: integer("cancelled_at"),
  finalizedAt: integer("finalized_at"),
  dispatchState: text("dispatch_state", {
    enum: ["dispatching", "accepted", "uncertain", "rejected"],
  }).notNull(),
  dispatchError: text("dispatch_error"),
  executionState: text("execution_state"),
  reportReady: integer("report_ready", { mode: "boolean" }).notNull().default(false),
  finalizationStarted: integer("finalization_started", { mode: "boolean" })
    .notNull()
    .default(false),
  finalizationError: text("finalization_error"),
  baselineRoot: text("baseline_root"),
  baselineError: text("baseline_error"),
  expectedChanges: text("expected_changes", { mode: "json" }).$type<ExpectedChange[]>(),
  checks: text("checks", { mode: "json" }).$type<VerificationCheck[]>(),
  report: text("report", { mode: "json" }).$type<ExecutionReport>(),
  usage: text("usage", { mode: "json" }).$type<ExecutionUsageSnapshot>(),
  result: text("result", { mode: "json" }).$type<CachedTaskResult>(),
  observerInstanceId: text("observer_instance_id"),
  observerGeneration: integer("observer_generation").notNull().default(0),
});

export const workspaceBaselines = sqliteTable(
  "workspace_baselines",
  {
    runId: text("run_id")
      .notNull()
      .references(() => taskRuns.runId, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    sha256: text("sha256").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.relativePath] })],
);

export const usageLedger = sqliteTable(
  "usage_ledger",
  {
    runId: text("run_id").primaryKey(),
    taskId: text("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    capturedAt: integer("captured_at").notNull(),
    messageCount: integer("message_count").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cacheRead: integer("cache_read"),
    cacheWrite: integer("cache_write"),
    reportedCost: real("reported_cost"),
    complete: integer("complete", { mode: "boolean" }).notNull(),
    breakdown: text("breakdown", { mode: "json" }).$type<UsageBreakdown[]>(),
  },
  (table) => [index("usage_ledger_captured_at_idx").on(table.capturedAt)],
);

export const quotaSnapshots = sqliteTable("quota_snapshots", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  spendBudget: text("spend_budget", { mode: "json" }).$type<SpendBudget>().notNull(),
  models: text("models", { mode: "json" }).$type<ModelQuota[]>().notNull(),
});

export const workspaceLeases = sqliteTable(
  "workspace_leases",
  {
    leaseId: text("lease_id").primaryKey(),
    workspaceRoot: text("workspace_root").notNull(),
    exclusive: integer("exclusive", { mode: "boolean" }).notNull(),
    runId: text("run_id"),
    ownerInstanceId: text("owner_instance_id").notNull(),
    ownerPid: integer("owner_pid").notNull(),
    acquiredAt: integer("acquired_at").notNull(),
  },
  (table) => [index("workspace_leases_workspace_root_idx").on(table.workspaceRoot)],
);

export const taskDispatchLeases = sqliteTable("task_dispatch_leases", {
  taskId: text("task_id").primaryKey(),
  ownerInstanceId: text("owner_instance_id").notNull(),
  ownerPid: integer("owner_pid").notNull(),
  acquiredAt: integer("acquired_at").notNull(),
});

export type McpInstanceRow = InferSelectModel<typeof mcpInstances>;
export type ServerRow = InferSelectModel<typeof servers>;
export type WorkspaceRow = InferSelectModel<typeof workspaces>;
export type TaskRow = InferSelectModel<typeof tasks>;
export type TaskRunRow = InferSelectModel<typeof taskRuns>;
export type WorkspaceBaselineRow = InferSelectModel<typeof workspaceBaselines>;
export type UsageLedgerRow = InferSelectModel<typeof usageLedger>;
export type QuotaSnapshotRow = InferSelectModel<typeof quotaSnapshots>;
export type WorkspaceLeaseRow = InferSelectModel<typeof workspaceLeases>;
export type TaskDispatchLeaseRow = InferSelectModel<typeof taskDispatchLeases>;

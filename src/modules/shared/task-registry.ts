import { and, eq } from "drizzle-orm";
import { getDb, getInstanceId, isInstanceAlive, withImmediateTx } from "./db/index.js";
import {
  type TaskDispatchLeaseRow,
  type TaskRow,
  type TaskRunRow,
  taskDispatchLeases,
  taskRuns,
  tasks,
} from "./db/schema.js";
import type {
  ExecutionReport,
  ExpectedChange,
  VerificationCheck,
  WorkspaceSnapshot,
} from "./execution-report.js";
import { insertWorkspaceBaselineRows, releaseWorkspace } from "./execution-report.js";
import type { ExecutionUsageSnapshot } from "./execution-usage.js";
import type { WorkspaceMetadata } from "./workspace-manager.js";

export interface TaskRecord {
  taskId: string;
  serverId: string;
  sessionId: string;
  /** Epoch ms when the task was started; used to detect tasks that never produced output. */
  createdAt?: number;
  /**
   * Epoch ms when the task was cancelled. Without it an aborted session whose
   * last assistant message carries a completed timestamp reports `completed`,
   * which is indistinguishable from a task that finished on its own.
   */
  cancelledAt?: number;
  /** Accepted prompt history; additive metadata for later reporting and usage. */
  runs?: TaskRunRecord[];
  /** Current run id, used to scope all lifecycle reads. */
  currentRunId?: string;
  /** Reservation prevents overlapping continuation/dispatch operations. */
  dispatching?: boolean;
  /** Canonical directory inherited by the server process. */
  directory?: string;
  workspace?: WorkspaceMetadata;
  workspaceId?: string;
}

export interface TaskRunRecord {
  run_id: string;
  message_id: string;
  startedAt: number;
  cancelledAt?: number;
  finalizedAt?: number;
  report?: ExecutionReport;
  /** Immutable direct-message usage snapshot captured when this run was finalized. */
  usage?: ExecutionUsageSnapshot;
  result?: CachedTaskResult;
  expectedChanges?: ExpectedChange[];
  checks?: VerificationCheck[];
  baseline?: WorkspaceSnapshot;
  baselineRoot?: string;
  baselineError?: string;
  workspaceLease?: symbol;
  controller?: AbortController;
  executionState?: string;
  reportReady?: boolean;
  finalizationStarted?: boolean;
  finalizationError?: string;
  dispatchState?: "dispatching" | "accepted" | "uncertain" | "rejected";
  dispatchError?: string;
  agentName?: string;
  requestedProviderId?: string;
  requestedModelId?: string;
  observerInstanceId?: string;
  observerGeneration?: number;
}

export type TaskDispatchSnapshot = {
  currentRunId?: string;
  createdAt?: number;
  cancelledAt?: number;
};

export type CachedTaskResult = {
  task_id: string;
  run_id: string;
  status: string;
  result: string | null;
  error?: string;
  message?: string;
  usage?: ExecutionUsageSnapshot;
  progress?: {
    text_snippet: string;
    tool_calls_completed: number;
    mutating_tool_calls?: number;
    files_touched?: string[];
    current_tool?: string;
    current_tool_status?: string;
  };
};

type RunRowInsert = typeof taskRuns.$inferInsert;
type RunRowUpdate = Omit<
  RunRowInsert,
  "runId" | "taskId" | "messageId" | "observerInstanceId" | "observerGeneration"
>;

const taskMap = new Map<string, TaskRecord>();

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function leaseOwnerAlive(
  lease: Pick<TaskDispatchLeaseRow, "ownerInstanceId" | "ownerPid">,
): boolean {
  if (lease.ownerInstanceId === getInstanceId()) return true;
  if (isInstanceAlive(lease.ownerInstanceId)) return true;
  return processAlive(lease.ownerPid);
}

function runColumnValues(run: TaskRunRecord): RunRowUpdate {
  run.baselineRoot ??= run.baseline?.root;
  return {
    agentName: run.agentName ?? null,
    requestedProviderId: run.requestedProviderId ?? null,
    requestedModelId: run.requestedModelId ?? null,
    startedAt: run.startedAt,
    cancelledAt: run.cancelledAt ?? null,
    finalizedAt: run.finalizedAt ?? null,
    dispatchState: run.dispatchState ?? "accepted",
    dispatchError: run.dispatchError ?? null,
    executionState: run.executionState ?? null,
    reportReady: run.reportReady ?? false,
    finalizationStarted: run.finalizationStarted ?? false,
    finalizationError: run.finalizationError ?? null,
    baselineRoot: run.baselineRoot ?? null,
    baselineError: run.baselineError ?? null,
    expectedChanges: run.expectedChanges ?? null,
    checks: run.checks ?? null,
    report: run.report ?? null,
    usage: run.usage ?? null,
    result: run.result ?? null,
  };
}

function runInsertValues(taskId: string, run: TaskRunRecord): RunRowInsert {
  return {
    runId: run.run_id,
    taskId,
    messageId: run.message_id,
    ...runColumnValues(run),
    observerInstanceId: run.observerInstanceId ?? null,
    observerGeneration: run.observerGeneration ?? 0,
  };
}

function storeBaseline(run: TaskRunRecord): void {
  if (!run.baseline) return;
  insertWorkspaceBaselineRows(run.run_id, run.baseline);
  run.baseline = undefined;
}

function persistRunRecord(taskId: string, run: TaskRunRecord): void {
  const existing = getDb()
    .select({ runId: taskRuns.runId })
    .from(taskRuns)
    .where(eq(taskRuns.runId, run.run_id))
    .get();
  if (existing) {
    getDb().update(taskRuns).set(runColumnValues(run)).where(eq(taskRuns.runId, run.run_id)).run();
    storeBaseline(run);
  } else {
    const values = runInsertValues(taskId, run);
    const inserted = getDb().insert(taskRuns).values(values).onConflictDoNothing().run();
    if (inserted.changes === 0) {
      getDb().delete(taskRuns).where(eq(taskRuns.messageId, run.message_id)).run();
      getDb().insert(taskRuns).values(values).run();
    }
    storeBaseline(run);
  }
}

function hydrateRun(row: TaskRunRow): TaskRunRecord {
  return {
    run_id: row.runId,
    message_id: row.messageId,
    startedAt: row.startedAt,
    ...(row.agentName !== null ? { agentName: row.agentName } : {}),
    ...(row.requestedProviderId !== null ? { requestedProviderId: row.requestedProviderId } : {}),
    ...(row.requestedModelId !== null ? { requestedModelId: row.requestedModelId } : {}),
    ...(row.cancelledAt !== null ? { cancelledAt: row.cancelledAt } : {}),
    ...(row.finalizedAt !== null ? { finalizedAt: row.finalizedAt } : {}),
    dispatchState: row.dispatchState,
    ...(row.dispatchError !== null ? { dispatchError: row.dispatchError } : {}),
    ...(row.executionState !== null ? { executionState: row.executionState } : {}),
    reportReady: row.reportReady,
    finalizationStarted: row.finalizationStarted,
    ...(row.finalizationError !== null ? { finalizationError: row.finalizationError } : {}),
    ...(row.baselineRoot !== null ? { baselineRoot: row.baselineRoot } : {}),
    ...(row.baselineError !== null ? { baselineError: row.baselineError } : {}),
    ...(row.expectedChanges !== null ? { expectedChanges: row.expectedChanges } : {}),
    ...(row.checks !== null ? { checks: row.checks } : {}),
    ...(row.report !== null ? { report: row.report } : {}),
    ...(row.usage !== null ? { usage: row.usage } : {}),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.observerInstanceId !== null ? { observerInstanceId: row.observerInstanceId } : {}),
    observerGeneration: row.observerGeneration,
  };
}

function hydrateTask(row: TaskRow, runRows: TaskRunRow[]): TaskRecord {
  return {
    taskId: row.taskId,
    serverId: row.serverId,
    sessionId: row.sessionId,
    createdAt: row.startedAt,
    ...(row.cancelledAt !== null ? { cancelledAt: row.cancelledAt } : {}),
    ...(row.currentRunId !== null ? { currentRunId: row.currentRunId } : {}),
    ...(row.directory !== null ? { directory: row.directory } : {}),
    ...(row.workspaceMetadata !== null ? { workspace: row.workspaceMetadata } : {}),
    ...(row.workspaceId !== null ? { workspaceId: row.workspaceId } : {}),
    runs: runRows.map(hydrateRun),
  };
}

function hydrateTaskById(taskId: string): TaskRecord | undefined {
  const row = getDb().select().from(tasks).where(eq(tasks.taskId, taskId)).get();
  if (!row) return undefined;
  const runRows = getDb()
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId))
    .orderBy(taskRuns.startedAt)
    .all();
  const record = hydrateTask(row, runRows);
  taskMap.set(taskId, record);
  return record;
}

export function registerTask(task: TaskRecord) {
  task.runs ??= [];
  const runs = task.runs;
  const lastRun = runs.at(-1);
  const existing = getDb()
    .select({ createdAt: tasks.createdAt })
    .from(tasks)
    .where(eq(tasks.taskId, task.taskId))
    .get();
  const startedAt = task.createdAt ?? lastRun?.startedAt ?? Date.now();
  withImmediateTx(() => {
    getDb()
      .insert(tasks)
      .values({
        taskId: task.taskId,
        serverId: task.serverId,
        sessionId: task.sessionId,
        directory: task.directory ?? null,
        workspaceId: task.workspaceId ?? null,
        workspaceMetadata: task.workspace ?? null,
        currentRunId: task.currentRunId ?? null,
        createdAt: existing?.createdAt ?? startedAt,
        startedAt,
        cancelledAt: task.cancelledAt ?? null,
      })
      .onConflictDoUpdate({
        target: tasks.taskId,
        set: {
          startedAt,
          currentRunId: task.currentRunId ?? null,
          workspaceId: task.workspaceId ?? null,
          workspaceMetadata: task.workspace ?? null,
          cancelledAt: task.cancelledAt ?? null,
        },
      })
      .run();
    for (const run of runs) persistRunRecord(task.taskId, run);
  });
  taskMap.set(task.taskId, task);
}

export function getTask(taskId: string): TaskRecord | undefined {
  const hot = taskMap.get(taskId);
  if (hot) return hot;
  return hydrateTaskById(taskId);
}

export function tasksForServer(serverId: string): TaskRecord[] {
  const rows = getDb().select().from(tasks).where(eq(tasks.serverId, serverId)).all();
  for (const row of rows) if (!taskMap.has(row.taskId)) hydrateTaskById(row.taskId);
  return [...taskMap.values()].filter((task) => task.serverId === serverId);
}

export function allTasks(): TaskRecord[] {
  const rows = getDb().select({ taskId: tasks.taskId }).from(tasks).all();
  for (const row of rows) if (!taskMap.has(row.taskId)) hydrateTaskById(row.taskId);
  return [...taskMap.values()];
}

/**
 * Record that a task was cancelled. No-ops for an unknown id so callers do not
 * have to re-check the registry after aborting.
 */
export function markTaskCancelled(taskId: string, at: number = Date.now()) {
  const task = getTask(taskId);
  if (!task) return;
  task.cancelledAt = at;
  const run = task.runs?.find((item) => item.run_id === task.currentRunId);
  if (run) run.cancelledAt = at;
  withImmediateTx(() => {
    getDb().update(tasks).set({ cancelledAt: at }).where(eq(tasks.taskId, taskId)).run();
    if (task.currentRunId !== undefined)
      getDb()
        .update(taskRuns)
        .set({ cancelledAt: at })
        .where(and(eq(taskRuns.runId, task.currentRunId), eq(taskRuns.taskId, taskId)))
        .run();
  });
  run?.controller?.abort(new Error("task cancelled"));
}

export function reserveTaskDispatch(taskId: string): boolean {
  const claimed = withImmediateTx(() => {
    const existing = getDb()
      .select()
      .from(taskDispatchLeases)
      .where(eq(taskDispatchLeases.taskId, taskId))
      .get();
    if (existing) {
      if (leaseOwnerAlive(existing)) return false;
      getDb().delete(taskDispatchLeases).where(eq(taskDispatchLeases.taskId, taskId)).run();
    }
    getDb()
      .insert(taskDispatchLeases)
      .values({
        taskId,
        ownerInstanceId: getInstanceId(),
        ownerPid: process.pid,
        acquiredAt: Date.now(),
      })
      .run();
    return true;
  });
  if (!claimed) return false;
  const task = taskMap.get(taskId);
  if (task) task.dispatching = true;
  return true;
}

export function releaseTaskDispatch(taskId: string): void {
  getDb()
    .delete(taskDispatchLeases)
    .where(
      and(
        eq(taskDispatchLeases.taskId, taskId),
        eq(taskDispatchLeases.ownerInstanceId, getInstanceId()),
      ),
    )
    .run();
  const task = taskMap.get(taskId);
  if (task) task.dispatching = false;
}

export function acceptTaskRun(taskId: string, run: TaskRunRecord): void {
  const task = getTask(taskId);
  if (!task) return;
  withImmediateTx(() => {
    getDb()
      .update(tasks)
      .set({ currentRunId: run.run_id, startedAt: run.startedAt, cancelledAt: null })
      .where(eq(tasks.taskId, taskId))
      .run();
    persistRunRecord(taskId, run);
  });
  task.runs ??= [];
  if (!task.runs.some((item) => item.run_id === run.run_id)) task.runs.push(run);
  task.currentRunId = run.run_id;
  task.createdAt = run.startedAt;
  task.cancelledAt = undefined;
}

export function snapshotTaskDispatch(taskId: string): TaskDispatchSnapshot | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  return {
    currentRunId: task.currentRunId,
    createdAt: task.createdAt,
    cancelledAt: task.cancelledAt,
  };
}

export function rollbackTaskRun(
  taskId: string,
  runId: string,
  previous: TaskDispatchSnapshot | undefined,
): void {
  const task = getTask(taskId);
  if (!task) return;
  const run = task.runs?.find((item) => item.run_id === runId);
  run?.controller?.abort(new Error("prompt dispatch rejected"));
  if (run?.workspaceLease) releaseWorkspace(run.workspaceLease);
  withImmediateTx(() => {
    getDb().delete(taskRuns).where(eq(taskRuns.runId, runId)).run();
    const existing = getDb()
      .select({ startedAt: tasks.startedAt })
      .from(tasks)
      .where(eq(tasks.taskId, taskId))
      .get();
    getDb()
      .update(tasks)
      .set({
        currentRunId: previous?.currentRunId ?? null,
        startedAt: previous?.createdAt ?? existing?.startedAt ?? Date.now(),
        cancelledAt: previous?.cancelledAt ?? null,
      })
      .where(eq(tasks.taskId, taskId))
      .run();
  });
  task.runs = (task.runs ?? []).filter((item) => item.run_id !== runId);
  task.currentRunId = previous?.currentRunId;
  task.createdAt = previous?.createdAt;
  task.cancelledAt = previous?.cancelledAt;
}

export function removeTask(taskId: string) {
  const task = taskMap.get(taskId);
  if (task?.dispatching) return;
  if (!task) {
    const lease = getDb()
      .select({ taskId: taskDispatchLeases.taskId })
      .from(taskDispatchLeases)
      .where(eq(taskDispatchLeases.taskId, taskId))
      .get();
    if (lease) return;
  }
  for (const run of task?.runs ?? []) {
    run.controller?.abort(new Error("task removed"));
    if (run.workspaceLease) releaseWorkspace(run.workspaceLease);
  }
  withImmediateTx(() => {
    getDb().delete(taskDispatchLeases).where(eq(taskDispatchLeases.taskId, taskId)).run();
    getDb().delete(tasks).where(eq(tasks.taskId, taskId)).run();
  });
  taskMap.delete(taskId);
}

export function resetTaskRegistryForTests(): void {
  taskMap.clear();
}

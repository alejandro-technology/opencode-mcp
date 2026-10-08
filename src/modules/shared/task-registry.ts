import type {
  ExecutionReport,
  ExpectedChange,
  VerificationCheck,
  WorkspaceSnapshot,
} from "./execution-report.js";
import { releaseWorkspace } from "./execution-report.js";
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
  report?: ExecutionReport;
  /** Immutable direct-message usage snapshot captured when this run was finalized. */
  usage?: ExecutionUsageSnapshot;
  result?: CachedTaskResult;
  expectedChanges?: ExpectedChange[];
  checks?: VerificationCheck[];
  baseline?: WorkspaceSnapshot;
  baselineError?: string;
  workspaceLease?: symbol;
  controller?: AbortController;
  executionState?: string;
  reportReady?: boolean;
  finalizationStarted?: boolean;
  finalizationError?: string;
  dispatchState?: "dispatching" | "accepted" | "uncertain" | "rejected";
  dispatchError?: string;
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

const tasks = new Map<string, TaskRecord>();
const dispatchReservations = new Set<string>();

export function registerTask(task: TaskRecord) {
  task.runs ??= [];
  tasks.set(task.taskId, task);
}

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export function tasksForServer(serverId: string): TaskRecord[] {
  return [...tasks.values()].filter((task) => task.serverId === serverId);
}

export function allTasks(): TaskRecord[] {
  return [...tasks.values()];
}

/**
 * Record that a task was cancelled. No-ops for an unknown id so callers do not
 * have to re-check the registry after aborting.
 */
export function markTaskCancelled(taskId: string, at: number = Date.now()) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.cancelledAt = at;
  const run = task.runs?.find((item) => item.run_id === task.currentRunId);
  if (run) {
    run.cancelledAt = at;
    run.controller?.abort(new Error("task cancelled"));
  }
}

export function reserveTaskDispatch(taskId: string): boolean {
  if (dispatchReservations.has(taskId)) return false;
  dispatchReservations.add(taskId);
  const task = tasks.get(taskId);
  if (task) task.dispatching = true;
  return true;
}

export function releaseTaskDispatch(taskId: string): void {
  dispatchReservations.delete(taskId);
  const task = tasks.get(taskId);
  if (task) task.dispatching = false;
}

export function acceptTaskRun(taskId: string, run: TaskRunRecord): void {
  const task = tasks.get(taskId);
  if (!task) return;
  task.runs ??= [];
  task.runs.push(run);
  task.currentRunId = run.run_id;
  task.createdAt = run.startedAt;
  task.cancelledAt = undefined;
}

export function snapshotTaskDispatch(taskId: string): TaskDispatchSnapshot | undefined {
  const task = tasks.get(taskId);
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
  const task = tasks.get(taskId);
  if (!task) return;
  const run = task.runs?.find((item) => item.run_id === runId);
  run?.controller?.abort(new Error("prompt dispatch rejected"));
  if (run?.workspaceLease) releaseWorkspace(run.workspaceLease);
  task.runs = (task.runs ?? []).filter((item) => item.run_id !== runId);
  task.currentRunId = previous?.currentRunId;
  task.createdAt = previous?.createdAt;
  task.cancelledAt = previous?.cancelledAt;
}

export function removeTask(taskId: string) {
  const task = tasks.get(taskId);
  if (!task) return;
  // Do not drop the only record of a writer while a prompt ACK is unresolved.
  // The dispatcher will either roll it back on a definite rejection or leave
  // the run tracked when the result is ambiguous.
  if (task.dispatching) return;
  for (const run of task.runs ?? []) {
    run.controller?.abort(new Error("task removed"));
    if (run.workspaceLease) releaseWorkspace(run.workspaceLease);
  }
  tasks.delete(taskId);
}

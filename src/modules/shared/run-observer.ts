import { and, eq, isNull, or } from "drizzle-orm";
import { getDb, getInstanceId, withImmediateTx } from "./db/index.js";
import { taskRuns } from "./db/schema.js";
import { upsertUsageLedger } from "./db/usage.js";
import {
  abortAndDrainChecks,
  captureReport,
  deleteWorkspaceBaseline,
  type ExecutionReport,
  loadWorkspaceBaseline,
  releaseWorkspace,
} from "./execution-report.js";
import type { ExecutionUsageSnapshot } from "./execution-usage.js";
import { buildExecutionUsage } from "./execution-usage.js";
import {
  assistantEntries,
  buildProgress,
  CANCELLED_TASK_MESSAGE,
  clientForTask,
  deriveTaskStatus,
  EMPTY_TURN_MESSAGE,
  hasWork,
  sessionParts,
} from "./opencode-client.js";
import {
  allTasks,
  getTask,
  type TaskRecord,
  type TaskRunRecord,
  tasksForServer,
} from "./task-registry.js";

function unavailableUsage(diagnostic: string): ExecutionUsageSnapshot {
  return {
    captured_at: new Date().toISOString(),
    snapshot_kind: "run_finalization",
    report: null,
    diagnostic,
  };
}

type RunPatch = Partial<typeof taskRuns.$inferInsert>;

const observers = new Map<string, { stopped: boolean; taskId: string }>();
const terminal = new Set(["completed", "failed", "empty", "cancelled"]);

export function persistRunState(runId: string, patch: RunPatch): void {
  getDb().update(taskRuns).set(patch).where(eq(taskRuns.runId, runId)).run();
}

export function claimRunFinalization(runId: string): number | undefined {
  return withImmediateTx(() => {
    const row = getDb()
      .select({
        observerInstanceId: taskRuns.observerInstanceId,
        observerGeneration: taskRuns.observerGeneration,
        finalizationStarted: taskRuns.finalizationStarted,
      })
      .from(taskRuns)
      .where(eq(taskRuns.runId, runId))
      .get();
    if (!row) return undefined;
    if (row.finalizationStarted) return undefined;
    const instanceId = getInstanceId();
    if (row.observerInstanceId !== null && row.observerInstanceId !== instanceId) return undefined;
    const generation = row.observerGeneration + 1;
    getDb()
      .update(taskRuns)
      .set({
        observerInstanceId: instanceId,
        observerGeneration: generation,
        finalizationStarted: true,
      })
      .where(
        and(
          eq(taskRuns.runId, runId),
          eq(taskRuns.finalizationStarted, false),
          or(isNull(taskRuns.observerInstanceId), eq(taskRuns.observerInstanceId, instanceId)),
        ),
      )
      .run();
    return generation;
  });
}

export function writeFinalizedRun(runId: string, generation: number, patch: RunPatch): boolean {
  const result = getDb()
    .update(taskRuns)
    .set(patch)
    .where(
      and(
        eq(taskRuns.runId, runId),
        eq(taskRuns.observerInstanceId, getInstanceId()),
        eq(taskRuns.observerGeneration, generation),
      ),
    )
    .run();
  return result.changes === 1;
}

function recordUsageLedger(task: TaskRecord, run: TaskRunRecord): void {
  const usage = run.usage;
  const report = usage?.report;
  if (!usage || !report) return;
  const session = report.session;
  const parsed = Date.parse(usage.captured_at);
  try {
    upsertUsageLedger({
      runId: run.run_id,
      taskId: task.taskId,
      sessionId: task.sessionId,
      capturedAt: Number.isFinite(parsed) ? parsed : Date.now(),
      messageCount: session.message_count,
      inputTokens: session.input.value,
      outputTokens: session.output.value,
      reasoningTokens: session.reasoning.value,
      cacheRead: session.cache_read.value,
      cacheWrite: session.cache_write.value,
      reportedCost: session.reported_cost.value,
      complete: [
        session.input,
        session.output,
        session.reasoning,
        session.cache_read,
        session.cache_write,
        session.reported_cost,
      ].every((metric) => metric.complete),
      breakdown: session.breakdown,
    });
  } catch {}
}

function finalizeRunPersistence(task: TaskRecord, run: TaskRunRecord, generation?: number): void {
  run.finalizedAt ??= Date.now();
  const patch: RunPatch = {
    executionState: run.executionState ?? null,
    reportReady: run.reportReady,
    finalizationStarted: run.finalizationStarted ?? false,
    finalizationError: run.finalizationError ?? null,
    finalizedAt: run.finalizedAt,
    report: run.report,
    usage: run.usage,
    result: run.result,
  };
  if (generation !== undefined) writeFinalizedRun(run.run_id, generation, patch);
  else persistRunState(run.run_id, patch);
  recordUsageLedger(task, run);
  deleteWorkspaceBaseline(run.run_id);
}

export function observeRun(taskId: string, runId: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const run = task.runs?.find((item) => item.run_id === runId);
  if (!run || run.reportReady) return;
  const state = { stopped: false, taskId };
  observers.set(runId, state);
  persistRunState(runId, {
    dispatchState: run.dispatchState ?? "accepted",
    dispatchError: run.dispatchError ?? null,
  });
  void (async () => {
    let errors = 0;
    let execution = "pending";
    let finalizationGeneration: number | undefined;
    while (!state.stopped) {
      const current = getTask(taskId);
      if (!current) break;
      const run = current.runs?.find((item) => item.run_id === runId);
      if (!run) break;
      try {
        const client = clientForTask(taskId);
        if (!client) {
          errors++;
        } else {
          const status = await deriveTaskStatus(client.client, client.sessionId, taskId, {
            includeUsage: true,
            usageMessageID: run.message_id,
          });
          errors = 0;
          execution = status.status;
          run.executionState = execution;
          persistRunState(runId, { executionState: execution });
          if (terminal.has(status.status)) {
            if (run.finalizationStarted) break;
            finalizationGeneration = claimRunFinalization(runId);
            if (finalizationGeneration === undefined) {
              state.stopped = true;
              break;
            }
            run.finalizationStarted = true;
            const finalExecution = run.cancelledAt !== undefined ? "cancelled" : status.status;
            run.executionState = finalExecution;
            if (status.usage) {
              run.usage = {
                ...status.usage,
                snapshot_kind: "run_finalization",
              };
              if (status.usage.diagnostic) run.report?.diagnostics.push(status.usage.diagnostic);
            } else
              run.usage = unavailableUsage(
                "usage unavailable: no final message snapshot was returned",
              );
            persistRunState(runId, { executionState: finalExecution, usage: run.usage });
            const verificationRequested = Boolean(
              run.expectedChanges?.length || run.checks?.length,
            );
            if (verificationRequested)
              run.report = {
                changes: [],
                verification: { state: "running", checks: [], execution_state: finalExecution },
                diagnostics: [],
                evidence: {
                  source: "workspace_delta",
                  inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
                  complete: false,
                  errors: [],
                  attribution: "uncertain_shared_workspace",
                },
              };
            const baseline =
              run.baselineRoot !== undefined ? loadWorkspaceBaseline(run.run_id) : undefined;
            run.report = baseline
              ? await captureReport(
                  baseline,
                  run.expectedChanges ?? [],
                  run.checks ?? [],
                  finalExecution,
                  run.controller?.signal,
                )
              : {
                  changes: [],
                  verification: {
                    state: verificationRequested ? "unavailable" : "not_requested",
                    checks: [],
                  },
                  diagnostics: [run.baselineError ?? "workspace baseline unavailable"],
                  evidence: {
                    source: "workspace_delta",
                    inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
                    complete: false,
                    errors: [run.baselineError ?? "workspace baseline unavailable"],
                    attribution: "uncertain_shared_workspace",
                  },
                };
            run.report.verification = {
              ...run.report.verification,
              execution_state: finalExecution,
            };
            persistRunState(runId, { report: run.report });
            const checksDrained = run.report.verification.checks.every(
              (check) => check.termination_confirmed !== false,
            );
            if (!checksDrained) {
              run.report.verification.state = "unavailable";
              run.report.diagnostics.push(
                "check process termination was not confirmed; workspace lease retained",
              );
              run.report.evidence.complete = false;
              run.report.evidence.errors.push("check process termination not confirmed");
              run.finalizationError = "check process termination was not confirmed";
              persistRunState(runId, {
                report: run.report,
                finalizationError: run.finalizationError,
              });
            }
            if (run.dispatchError)
              run.report.diagnostics.unshift(
                `prompt dispatch acknowledgement was uncertain: ${run.dispatchError}`,
              );
            await cacheFinalResult(
              taskId,
              runId,
              finalExecution,
              status.error,
              finalizationGeneration,
            );
            run.reportReady = true;
            if (checksDrained && run.workspaceLease) {
              releaseWorkspace(run.workspaceLease);
              run.workspaceLease = undefined;
            }
            finalizeRunPersistence(task, run, finalizationGeneration);
            state.stopped = true;
            break;
          }
        }
      } catch {
        if (run.finalizationStarted) {
          run.finalizationError = "run finalization failed; evidence could not be safely completed";
          run.usage ??= unavailableUsage("usage unavailable: run finalization failed");
          run.report = {
            changes: [],
            verification: {
              state: "unavailable",
              checks: [],
              execution_state: run.executionState,
            },
            diagnostics: [run.finalizationError, run.usage.diagnostic ?? "usage unavailable"],
            evidence: {
              source: "workspace_delta",
              inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
              complete: false,
              errors: [run.finalizationError],
              attribution: "uncertain_shared_workspace",
            },
          };
          run.result ??= {
            task_id: taskId,
            run_id: runId,
            status: execution,
            result: null,
            error: run.finalizationError,
          };
          run.reportReady = true;
          finalizeRunPersistence(task, run, finalizationGeneration);
          state.stopped = true;
          break;
        }
        errors++;
      }
      if (errors >= 3) {
        run.usage ??= unavailableUsage(
          "usage unavailable: lifecycle observation failed repeatedly",
        );
        run.report = {
          changes: [],
          verification: { state: "unavailable", checks: [], execution_state: execution },
          diagnostics: [
            "lifecycle observation failed repeatedly; workspace delta was not captured",
            run.usage.diagnostic ?? "usage unavailable",
          ],
          evidence: {
            source: "workspace_delta",
            inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
            complete: false,
            errors: ["lifecycle observation failed"],
            attribution: "uncertain_shared_workspace",
          },
        };
        run.result ??= {
          task_id: taskId,
          run_id: runId,
          status: execution,
          result: null,
          error: "lifecycle observation failed repeatedly",
        };
        run.reportReady = true;
        // The session may still be writing despite failed status reads. Keep its
        // lease until confirmed cancellation or server shutdown; never infer exit.
        finalizeRunPersistence(task, run);
        state.stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    observers.delete(runId);
  })();
}

async function cacheFinalResult(
  taskId: string,
  runId: string,
  status: string,
  error?: string,
  generation?: number,
): Promise<void> {
  const task = getTask(taskId);
  const run = task?.runs?.find((item) => item.run_id === runId);
  if (!task || !run || run.result) return;
  const resolved = clientForTask(taskId);
  if (!resolved) {
    run.usage ??= unavailableUsage(
      "usage unavailable: OpenCode server unavailable at run finalization",
    );
    run.report?.diagnostics.push(run.usage.diagnostic ?? "usage unavailable");
    run.result = {
      task_id: taskId,
      run_id: runId,
      status,
      result: null,
      error: "OpenCode server unavailable",
      usage: run.usage,
    };
    persistRunResult(runId, run, generation);
    return;
  }
  try {
    const allEntries = await assistantEntries(resolved.client, resolved.sessionId);
    const entries = allEntries.filter((entry) => entry.info.parentID === run.message_id);
    const entry = entries.at(-1);
    const progress = entry ? buildProgress(entry.parts, sessionParts(entries)) : undefined;
    const text = entry
      ? entry.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("")
      : "";
    run.result = {
      task_id: taskId,
      run_id: runId,
      status,
      result: text || null,
      ...(error ? { error } : {}),
      ...(status === "cancelled" ? { message: CANCELLED_TASK_MESSAGE } : {}),
      ...(status === "empty" || !hasWork(entry?.parts ?? [])
        ? { message: EMPTY_TURN_MESSAGE }
        : {}),
      ...(progress ? { progress } : {}),
      ...(run.usage
        ? { usage: run.usage }
        : {
            usage: {
              captured_at: new Date().toISOString(),
              snapshot_kind: "run_finalization" as const,
              report: buildExecutionUsage(allEntries, run.message_id),
            },
          }),
    };
    run.usage ??= run.result.usage as ExecutionUsageSnapshot;
    persistRunResult(runId, run, generation);
  } catch (cause) {
    run.usage ??= unavailableUsage(
      `usage unavailable: final task messages could not be fetched (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    run.result = {
      task_id: taskId,
      run_id: runId,
      status,
      result: null,
      error: cause instanceof Error ? cause.message : String(cause),
      usage: run.usage,
    };
    // A terminal run always has a report before output caching starts; if that
    // invariant fails, the observer's finalization catch replaces it unavailable.
    const finalizedReport = run.report as ExecutionReport;
    finalizedReport.diagnostics.push(
      "final task output could not be cached from the OpenCode server",
      run.usage.diagnostic ?? "usage unavailable",
    );
    finalizedReport.evidence.complete = false;
    finalizedReport.evidence.errors.push("final task output unavailable");
    persistRunResult(runId, run, generation);
  }
}

function persistRunResult(runId: string, run: TaskRunRecord, generation?: number): void {
  const patch: RunPatch = {
    usage: run.usage,
    result: run.result,
    report: run.report,
  };
  if (generation !== undefined) writeFinalizedRun(runId, generation, patch);
  else persistRunState(runId, patch);
}

export async function stopRunObservers(timeoutMs = 5_000): Promise<boolean> {
  let allDrained = true;
  for (const task of allTasks()) {
    for (const run of task.runs ?? []) {
      if (run.reportReady && run.workspaceLease === undefined) continue;
      const drained = run.controller ? await abortAndDrainChecks(run.controller, timeoutMs) : true;
      if (!drained) allDrained = false;
      run.usage ??= unavailableUsage("usage unavailable: MCP server stopped before finalization");
      if (!run.reportReady) {
        run.report = {
          changes: [],
          verification: {
            state: "unavailable",
            checks: [],
            execution_state: "server_stopped",
          },
          diagnostics: [
            "MCP server stopped before the run could be fully observed",
            ...(drained
              ? []
              : ["check process termination was not confirmed; workspace lease retained"]),
            run.usage.diagnostic ?? "usage unavailable",
          ],
          evidence: {
            source: "workspace_delta",
            inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
            complete: false,
            errors: [
              "MCP server stopped",
              ...(drained ? [] : ["check process termination not confirmed"]),
            ],
            attribution: "uncertain_shared_workspace",
          },
        };
        run.reportReady = true;
      }
      run.result ??= {
        task_id: task.taskId,
        run_id: run.run_id,
        status: run.executionState ?? "unavailable",
        result: null,
        error: "MCP server stopped before final output was cached",
        usage: run.usage,
      };
      if (drained && run.workspaceLease) {
        releaseWorkspace(run.workspaceLease);
        run.workspaceLease = undefined;
      }
      finalizeRunPersistence(task, run);
    }
  }
  for (const state of observers.values()) {
    state.stopped = true;
  }
  observers.clear();
  return allDrained;
}

export async function stopServerObservers(serverId: string, timeoutMs = 5_000): Promise<boolean> {
  let allDrained = true;
  for (const task of tasksForServer(serverId)) {
    for (const run of task.runs ?? []) {
      if (run.reportReady && run.workspaceLease === undefined) continue;
      const drained = run.controller ? await abortAndDrainChecks(run.controller, timeoutMs) : true;
      if (!drained) allDrained = false;
      run.usage ??= unavailableUsage(
        "usage unavailable: OpenCode server stopped before finalization",
      );
      if (!run.reportReady) {
        run.report = {
          changes: [],
          verification: { state: "unavailable", checks: [], execution_state: "server_stopped" },
          diagnostics: [
            "OpenCode server stopped before the run could be fully observed",
            ...(drained
              ? []
              : ["check process termination was not confirmed; workspace lease retained"]),
            run.usage.diagnostic ?? "usage unavailable",
          ],
          evidence: {
            source: "workspace_delta",
            inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
            complete: false,
            errors: [
              "server stopped",
              ...(drained ? [] : ["check process termination not confirmed"]),
            ],
            attribution: "uncertain_shared_workspace",
          },
        };
      }
      run.finalizationError = "OpenCode server stopped before run finalization";
      run.controller?.abort(new Error("OpenCode server stopped"));
      run.reportReady = true;
      run.result ??= {
        task_id: task.taskId,
        run_id: run.run_id,
        status: run.executionState ?? "unavailable",
        result: null,
        error: "OpenCode server stopped before final output was cached",
        usage: run.usage,
      };
      if (drained && run.workspaceLease) {
        releaseWorkspace(run.workspaceLease);
        run.workspaceLease = undefined;
      }
      finalizeRunPersistence(task, run);
    }
  }
  for (const [runId, state] of observers) {
    if (tasksForServer(serverId).some((item) => item.taskId === state.taskId)) {
      state.stopped = true;
      observers.delete(runId);
    }
  }
  return allDrained;
}

export async function finishConfirmedCancellation(taskId: string): Promise<void> {
  const task = getTask(taskId);
  const run = task?.runs?.find((item) => item.run_id === task.currentRunId);
  if (!task || !run || observers.has(run.run_id)) return;
  if (
    run.reportReady &&
    !run.finalizationError &&
    run.executionState !== "pending" &&
    run.executionState !== "running"
  )
    return;
  const drained = run.controller ? await abortAndDrainChecks(run.controller, 5_000) : true;
  run.executionState = "cancelled";
  const baseline = run.baselineRoot !== undefined ? loadWorkspaceBaseline(run.run_id) : undefined;
  run.report = baseline
    ? await captureReport(
        baseline,
        run.expectedChanges ?? [],
        run.checks ?? [],
        "cancelled",
        run.controller?.signal,
      )
    : {
        changes: [],
        verification: {
          state:
            run.expectedChanges?.length || run.checks?.length ? "unavailable" : "not_requested",
          checks: [],
          execution_state: "cancelled",
        },
        diagnostics: [run.baselineError ?? "workspace baseline unavailable"],
        evidence: {
          source: "workspace_delta",
          inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
          complete: false,
          errors: [run.baselineError ?? "workspace baseline unavailable"],
          attribution: "uncertain_shared_workspace",
        },
      };
  run.report.verification.execution_state = "cancelled";
  if (!drained) {
    run.report.verification.state = "unavailable";
    run.report.diagnostics.push(
      "check process termination was not confirmed; workspace lease retained",
    );
    run.report.evidence.complete = false;
    run.report.evidence.errors.push("check process termination not confirmed");
    run.finalizationError = "check process termination was not confirmed";
  } else {
    run.finalizationError = undefined;
  }
  if (!run.result) await cacheFinalResult(taskId, run.run_id, "cancelled");
  else run.result.status = "cancelled";
  run.reportReady = true;
  if (drained && run.workspaceLease) {
    releaseWorkspace(run.workspaceLease);
    run.workspaceLease = undefined;
  }
  finalizeRunPersistence(task, run);
}

export function resetRunObserversForTests(): void {
  observers.clear();
}

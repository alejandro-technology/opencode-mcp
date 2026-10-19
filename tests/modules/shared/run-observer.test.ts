import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  abortAndDrainMock,
  captureReportMock,
  releaseWorkspaceMock,
  clientForTaskMock,
  deriveTaskStatusMock,
  assistantEntriesMock,
  hasWorkMock,
} = vi.hoisted(() => ({
  abortAndDrainMock: vi.fn(),
  captureReportMock: vi.fn(),
  releaseWorkspaceMock: vi.fn(),
  clientForTaskMock: vi.fn(),
  deriveTaskStatusMock: vi.fn(),
  assistantEntriesMock: vi.fn(),
  hasWorkMock: vi.fn(),
}));

vi.mock("../../../src/modules/shared/execution-report.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/modules/shared/execution-report.js")>();
  return {
    ...actual,
    abortAndDrainChecks: abortAndDrainMock,
    captureReport: captureReportMock,
    releaseWorkspace: releaseWorkspaceMock,
  };
});
vi.mock("../../../src/modules/shared/opencode-client.js", () => ({
  buildProgress: vi.fn(() => ({ text_snippet: "answer", tool_calls_completed: 0 })),
  CANCELLED_TASK_MESSAGE: "cancelled",
  clientForTask: clientForTaskMock,
  assistantEntries: assistantEntriesMock,
  deriveTaskStatus: deriveTaskStatusMock,
  EMPTY_TURN_MESSAGE: "empty",
  hasWork: hasWorkMock,
  sessionParts: vi.fn(() => []),
}));

const { getTask, registerTask, removeTask } = await import(
  "../../../src/modules/shared/task-registry.js"
);
const { finishConfirmedCancellation, observeRun, stopRunObservers, stopServerObservers } =
  await import("../../../src/modules/shared/run-observer.js");

const report = () => ({
  changes: [{ path: "made.txt", change: "created", evidence: "workspace_delta" as const }],
  verification: { state: "passed" as const, checks: [] },
  diagnostics: [],
  evidence: {
    source: "workspace_delta" as const,
    inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths" as const,
    complete: true,
    errors: [],
    attribution: "uncertain_shared_workspace" as const,
  },
});

function usageWithoutDiagnostic() {
  return {
    captured_at: "2026-10-08T00:00:00.000Z",
    snapshot_kind: "run_finalization" as const,
    report: null,
  };
}

function register(taskId: string, options: Record<string, unknown> = {}) {
  registerTask({
    taskId,
    serverId: "server-1",
    sessionId: "session-1",
    currentRunId: `run-${taskId}`,
    runs: [{ run_id: `run-${taskId}`, message_id: "msg-user", startedAt: Date.now(), ...options }],
  });
  const task = getTask(taskId);
  if (!task) throw new Error("test task registration failed");
  return task;
}

async function waitForReady(taskId: string) {
  await vi.waitFor(() => expect(getTask(taskId)?.runs?.[0].reportReady).toBe(true));
}

beforeEach(() => {
  captureReportMock.mockReset().mockResolvedValue(report());
  abortAndDrainMock.mockReset().mockResolvedValue(true);
  releaseWorkspaceMock.mockReset();
  clientForTaskMock.mockReset().mockReturnValue({ client: {}, sessionId: "session-1" });
  deriveTaskStatusMock.mockReset().mockResolvedValue({ task_id: "task", status: "completed" });
  assistantEntriesMock.mockReset().mockResolvedValue([
    {
      info: { id: "assistant-1", parentID: "msg-user" },
      parts: [{ type: "text", text: "answer" }],
    },
  ]);
  hasWorkMock.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  for (const taskId of [
    "success",
    "cache-error",
    "no-baseline",
    "poll-error",
    "stopped",
    "cancel",
    "missing",
    "missing-run",
    "empty-result",
    "cancelled-result",
    "backend-gone",
    "already-cached",
    "finalization-error",
    "shutdown-reported",
    "cancel-result",
    "cancel-undrained",
    "undrained-observer",
    "not-requested",
    "no-work",
    "orphan",
    "orphan-history",
    "empty-without-entry",
    "cancel-defaults",
    "dispatch-uncertain-run",
    "shutdown-complete",
    "shutdown-undrained",
  ])
    removeTask(taskId);
});

describe("run observer", () => {
  it("captures a run once, caches final text/progress, and releases its lease", async () => {
    const lease = Symbol("lease");
    const task = register("success", {
      baseline: { root: "/workspace", files: new Map() },
      expectedChanges: [{ path: "made.txt", change: "created" }],
      checks: [{ executable: "node", argv: [] }],
      workspaceLease: lease,
    });

    observeRun("success", "run-success");
    observeRun("success", "run-success");
    await waitForReady("success");

    expect(captureReportMock).toHaveBeenCalledOnce();
    expect(task.runs?.[0].report).toEqual({
      ...report(),
      verification: { state: "passed", checks: [], execution_state: "completed" },
    });
    expect(task.runs?.[0].result).toMatchObject({
      task_id: "success",
      run_id: "run-success",
      status: "completed",
      result: "answer",
      progress: { text_snippet: "answer" },
    });
    expect(releaseWorkspaceMock).toHaveBeenCalledWith(lease);
  });

  it("keeps finalized usage snapshots immutable across later runs", async () => {
    const task = register("usage-history");
    const firstUsage = {
      captured_at: "2026-10-07T00:00:00.000Z",
      snapshot_kind: "live_observation" as const,
      report: { run: { message_count: 1 }, session: { message_count: 2 } },
      diagnostic: "one usage field was unavailable",
    };
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "usage-history",
      status: "completed",
      usage: firstUsage,
    });
    observeRun("usage-history", "run-usage-history");
    await waitForReady("usage-history");
    const firstSnapshot = task.runs?.[0].usage;
    expect(firstSnapshot).toMatchObject({
      snapshot_kind: "run_finalization",
      report: { run: { message_count: 1 }, session: { message_count: 2 } },
      diagnostic: "one usage field was unavailable",
    });

    task.runs?.push({ run_id: "run-later", message_id: "msg-later", startedAt: Date.now() + 1 });
    task.currentRunId = "run-later";
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "usage-history",
      status: "completed",
      usage: {
        ...firstUsage,
        diagnostic: undefined,
        captured_at: "2026-10-07T00:01:00.000Z",
        report: { run: { message_count: 1 }, session: { message_count: 4 } },
      },
    });
    observeRun("usage-history", "run-later");
    await vi.waitFor(() => expect(task.runs?.[1].reportReady).toBe(true));
    expect(task.runs?.[0].usage).toBe(firstSnapshot);
    expect(task.runs?.[0].result?.usage).toBe(firstSnapshot);
    expect(task.runs?.[1].usage?.report?.session.message_count).toBe(4);
  });

  it("marks final result capture failures incomplete but preserves terminal report readiness", async () => {
    const task = register("cache-error", {
      baseline: { root: "/workspace", files: new Map() },
      usage: usageWithoutDiagnostic(),
    });
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "cache-error",
      status: "completed",
      usage: usageWithoutDiagnostic(),
    });
    assistantEntriesMock.mockRejectedValueOnce(new Error("messages unavailable"));
    observeRun("cache-error", "run-cache-error");
    await waitForReady("cache-error");
    expect(task.runs?.[0].report?.evidence.complete).toBe(false);
    expect(task.runs?.[0].report?.diagnostics).toContain(
      "final task output could not be cached from the OpenCode server",
    );
    expect(task.runs?.[0].report?.diagnostics).toContain("usage unavailable");
    expect(task.runs?.[0].result?.error).toBe("messages unavailable");
  });

  it("reports baseline errors without claiming unavailable inventory is an empty delta", async () => {
    const task = register("no-baseline", {
      baselineError: "initial inventory exceeded budget",
      expectedChanges: [{ path: "created.txt", change: "created" }],
    });
    observeRun("no-baseline", "run-no-baseline");
    await waitForReady("no-baseline");
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].report?.evidence.errors).toEqual(["initial inventory exceeded budget"]);
    expect(captureReportMock).not.toHaveBeenCalled();
  });

  it("reports not_requested when a no-criteria run has no workspace baseline", async () => {
    const task = register("not-requested");
    observeRun("not-requested", "run-not-requested");
    await waitForReady("not-requested");
    expect(task.runs?.[0].report?.verification.state).toBe("not_requested");
    expect(task.runs?.[0].report?.evidence.errors).toEqual(["workspace baseline unavailable"]);
  });

  it("keeps the uncertain ACK diagnostic in the final report", async () => {
    const task = register("dispatch-uncertain-run", {
      baseline: { root: "/workspace", files: new Map() },
      dispatchState: "uncertain",
      dispatchError: "fetch ACK was lost",
    });
    observeRun("dispatch-uncertain-run", "run-dispatch-uncertain-run");
    await waitForReady("dispatch-uncertain-run");
    expect(task.runs?.[0].report?.diagnostics).toContain(
      "prompt dispatch acknowledgement was uncertain: fetch ACK was lost",
    );
  });

  it("does not release a live writer lease after repeated SDK observation failures", async () => {
    vi.useFakeTimers();
    const lease = Symbol("live-writer");
    const task = register("poll-error", {
      baseline: { root: "/workspace", files: new Map() },
      workspaceLease: lease,
      usage: usageWithoutDiagnostic(),
    });
    clientForTaskMock.mockReturnValue(undefined);
    observeRun("poll-error", "run-poll-error");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].reportReady).toBe(true);
    expect(task.runs?.[0].report?.diagnostics).toContain("usage unavailable");
    expect(releaseWorkspaceMock).not.toHaveBeenCalled();
  });

  it("cleans up stopped-server observers, leases, and cached unavailable results", async () => {
    const lease = Symbol("server-lease");
    const task = register("stopped", {
      baseline: { root: "/workspace", files: new Map() },
      workspaceLease: lease,
      usage: usageWithoutDiagnostic(),
    });
    await stopServerObservers("server-1");
    expect(task.runs?.[0].report?.verification.execution_state).toBe("server_stopped");
    expect(task.runs?.[0].reportReady).toBe(true);
    expect(task.runs?.[0].result?.error).toContain("server stopped");
    expect(task.runs?.[0].report?.diagnostics).toContain("usage unavailable");
    expect(releaseWorkspaceMock).toHaveBeenCalledWith(lease);
  });

  it("finalizes confirmed cancellation after the monitor has stopped", async () => {
    const task = register("cancel", {
      baseline: { root: "/workspace", files: new Map() },
      expectedChanges: [{ path: "never-created", change: "created" }],
      checks: [{ executable: "node", argv: [] }],
    });
    const run = task.runs?.[0];
    if (!run) throw new Error("test run registration failed");
    run.cancelledAt = Date.now();
    await finishConfirmedCancellation("cancel");
    expect(captureReportMock).toHaveBeenCalledWith(
      run.baseline,
      run.expectedChanges,
      run.checks,
      "cancelled",
      run.controller?.signal,
    );
    expect(task.runs?.[0].reportReady).toBe(true);
    expect(task.runs?.[0].result?.status).toBe("cancelled");
  });

  it("handles unknown runs and stops active observers during shutdown", async () => {
    observeRun("missing", "run-missing");
    expect(getTask("missing")).toBeUndefined();
    const task = register("stopped", {
      baseline: { root: "/workspace", files: new Map() },
      usage: usageWithoutDiagnostic(),
    });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "stopped", status: "running" });
    observeRun("stopped", "run-stopped");
    await stopRunObservers();
    expect(task.runs?.[0].reportReady).toBe(true);
    expect(task.runs?.[0].report?.verification.execution_state).toBe("server_stopped");
    expect(task.runs?.[0].report?.diagnostics).toContain("usage unavailable");
  });

  it("leaves a task untouched when asked to observe an unknown run id", () => {
    const task = register("missing-run");
    observeRun("missing-run", "another-run");
    expect(task.runs?.[0].reportReady).toBeUndefined();
  });

  it("caches empty and cancelled outcomes with their corresponding messages", async () => {
    const empty = register("empty-result", { baseline: { root: "/workspace", files: new Map() } });
    deriveTaskStatusMock.mockResolvedValueOnce({ task_id: "empty-result", status: "empty" });
    assistantEntriesMock.mockResolvedValueOnce([]);
    observeRun("empty-result", "run-empty-result");
    await waitForReady("empty-result");
    expect(empty.runs?.[0].result).toMatchObject({
      status: "empty",
      result: null,
      message: "empty",
    });

    const cancelled = register("cancelled-result", {
      baseline: { root: "/workspace", files: new Map() },
    });
    const cancelledRun = cancelled.runs?.[0];
    if (!cancelledRun) throw new Error("test run registration failed");
    cancelledRun.cancelledAt = Date.now();
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "cancelled-result",
      status: "cancelled",
    });
    observeRun("cancelled-result", "run-cancelled-result");
    await waitForReady("cancelled-result");
    expect(cancelledRun.result).toMatchObject({ status: "cancelled", message: "cancelled" });
  });

  it("caches backend-unavailable outcomes and preserves results already cached", async () => {
    const unavailable = register("backend-gone", {
      baseline: { root: "/workspace", files: new Map() },
      usage: usageWithoutDiagnostic(),
    });
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "backend-gone",
      status: "completed",
      usage: usageWithoutDiagnostic(),
    });
    clientForTaskMock
      .mockReturnValueOnce({ client: {}, sessionId: "session-1" })
      .mockReturnValueOnce(undefined);
    observeRun("backend-gone", "run-backend-gone");
    await waitForReady("backend-gone");
    expect(unavailable.runs?.[0].result?.error).toBe("OpenCode server unavailable");
    expect(unavailable.runs?.[0].report?.diagnostics).toContain("usage unavailable");

    const cached = register("already-cached", {
      baseline: { root: "/workspace", files: new Map() },
      result: {
        task_id: "already-cached",
        run_id: "run-already-cached",
        status: "completed",
        result: "cached",
      },
    });
    observeRun("already-cached", "run-already-cached");
    await waitForReady("already-cached");
    expect(cached.runs?.[0].result?.result).toBe("cached");
  });

  it("turns a finalization exception into an unavailable report without retrying checks", async () => {
    const task = register("finalization-error", {
      baseline: { root: "/workspace", files: new Map() },
      usage: usageWithoutDiagnostic(),
    });
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "finalization-error",
      status: "completed",
      usage: usageWithoutDiagnostic(),
    });
    captureReportMock.mockRejectedValueOnce(new Error("post-capture failed"));
    observeRun("finalization-error", "run-finalization-error");
    await waitForReady("finalization-error");
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].finalizationError).toContain("finalization failed");
    expect(task.runs?.[0].report?.diagnostics).toContain("usage unavailable");
    expect(captureReportMock).toHaveBeenCalledOnce();
  });

  it("preserves non-Error output failures and error statuses", async () => {
    const task = register("cache-error", { baseline: { root: "/workspace", files: new Map() } });
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "cache-error",
      status: "failed",
      error: "agent failed",
    });
    assistantEntriesMock.mockRejectedValueOnce("unexpected output error");
    observeRun("cache-error", "run-cache-error");
    await waitForReady("cache-error");
    expect(task.runs?.[0].result?.error).toBe("unexpected output error");
  });

  it("adds assistant errors and empty-work diagnostics to terminal cached results", async () => {
    const failed = register("finalization-error", {
      baseline: { root: "/workspace", files: new Map() },
    });
    deriveTaskStatusMock.mockResolvedValueOnce({
      task_id: "finalization-error",
      status: "failed",
      error: "agent rejected",
    });
    observeRun("finalization-error", "run-finalization-error");
    await waitForReady("finalization-error");
    expect(failed.runs?.[0].result?.error).toBe("agent rejected");

    const noWork = register("no-work", { baseline: { root: "/workspace", files: new Map() } });
    hasWorkMock.mockReturnValueOnce(false);
    observeRun("no-work", "run-no-work");
    await waitForReady("no-work");
    expect(noWork.runs?.[0].result).toMatchObject({
      status: "completed",
      result: "answer",
      message: "empty",
    });
  });

  it("treats a completed turn without any assistant output as empty work", async () => {
    const task = register("empty-without-entry", {
      baseline: { root: "/workspace", files: new Map() },
    });
    hasWorkMock.mockReturnValueOnce(false);
    assistantEntriesMock.mockResolvedValueOnce([]);
    observeRun("empty-without-entry", "run-empty-without-entry");
    await waitForReady("empty-without-entry");
    expect(task.runs?.[0].result).toMatchObject({
      status: "completed",
      result: null,
      message: "empty",
    });
  });

  it("releases a stuck writer only after confirmed cancellation and retains cached text", async () => {
    const lease = Symbol("cancelled-lease");
    const task = register("cancel-result", {
      baselineError: "baseline unavailable",
      expectedChanges: [{ path: "x", change: "created" }],
      result: {
        task_id: "cancel-result",
        run_id: "run-cancel-result",
        status: "pending",
        result: "partial output",
      },
      report: report(),
      reportReady: true,
      executionState: "pending",
      finalizationError: "observer failed",
      workspaceLease: lease,
    });
    await finishConfirmedCancellation("cancel-result");
    expect(task.runs?.[0].result).toMatchObject({
      status: "cancelled",
      result: "partial output",
    });
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].finalizationError).toBeUndefined();
    expect(releaseWorkspaceMock).toHaveBeenCalledWith(lease);
  });

  it("retries cancellation finalization after an unconfirmed check drain", async () => {
    const lease = Symbol("undrained-cancel");
    const task = register("cancel-undrained", {
      baseline: { root: "/workspace", files: new Map() },
      workspaceLease: lease,
      controller: new AbortController(),
    });
    const run = task.runs?.[0];
    if (!run) throw new Error("test run registration failed");
    abortAndDrainMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await finishConfirmedCancellation("cancel-undrained");

    expect(run.reportReady).toBe(true);
    expect(run.finalizationError).toBe("check process termination was not confirmed");
    expect(run.workspaceLease).toBe(lease);
    expect(releaseWorkspaceMock).not.toHaveBeenCalled();

    await finishConfirmedCancellation("cancel-undrained");

    expect(abortAndDrainMock).toHaveBeenCalledTimes(2);
    expect(run.finalizationError).toBeUndefined();
    expect(run.workspaceLease).toBeUndefined();
    expect(releaseWorkspaceMock).toHaveBeenCalledWith(lease);
  });

  it("retains a run lease when the report cannot confirm check termination", async () => {
    const lease = Symbol("undrained-observer");
    const task = register("undrained-observer", {
      baseline: { root: "/workspace", files: new Map() },
      checks: [{ executable: "node", argv: [] }],
      workspaceLease: lease,
    });
    const incompleteReport = report();
    incompleteReport.verification.checks.push({
      executable: "node",
      argv: [],
      exit_code: null,
      signal: null,
      duration_ms: 1,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      termination_confirmed: false,
    });
    captureReportMock.mockResolvedValueOnce(incompleteReport);

    observeRun("undrained-observer", "run-undrained-observer");
    await waitForReady("undrained-observer");

    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].report?.diagnostics).toContain(
      "check process termination was not confirmed; workspace lease retained",
    );
    expect(task.runs?.[0].finalizationError).toBe("check process termination was not confirmed");
    expect(task.runs?.[0].workspaceLease).toBe(lease);
    expect(releaseWorkspaceMock).not.toHaveBeenCalled();
  });

  it("does not recapture finalized runs or runs still being observed", async () => {
    const finished = register("shutdown-reported", {
      report: report(),
      reportReady: true,
      executionState: "completed",
    });
    await finishConfirmedCancellation("shutdown-reported");
    expect(finished.runs?.[0].report?.verification.state).toBe("passed");

    const active = register("cancel", { baseline: { root: "/workspace", files: new Map() } });
    deriveTaskStatusMock.mockResolvedValueOnce({ task_id: "cancel", status: "running" });
    observeRun("cancel", "run-cancel");
    await finishConfirmedCancellation("cancel");
    expect(active.runs?.[0].reportReady).toBeUndefined();
    await stopRunObservers();
  });

  it("marks finalization unavailable when status requests repeatedly throw", async () => {
    vi.useFakeTimers();
    const task = register("poll-error", { baseline: { root: "/workspace", files: new Map() } });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "session-1" });
    deriveTaskStatusMock.mockRejectedValue(new Error("poll failed"));
    observeRun("poll-error", "run-poll-error");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].reportReady).toBe(true);
  });

  it("stops active monitors for their own server and ignores unrelated servers", async () => {
    const task = register("shutdown-reported", {
      baseline: { root: "/workspace", files: new Map() },
      usage: usageWithoutDiagnostic(),
    });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "shutdown-reported", status: "running" });
    observeRun("shutdown-reported", "run-shutdown-reported");
    await stopServerObservers("different-server");
    expect(task.runs?.[0].reportReady).toBeUndefined();
    await stopServerObservers("server-1");
    expect(task.runs?.[0].reportReady).toBe(true);
    expect(task.runs?.[0].report?.diagnostics).toContain("usage unavailable");
    await stopServerObservers("server-1");
    task.runs = undefined;
    await stopServerObservers("server-1");
  });

  it("skips removed tasks during shutdown observer cleanup", async () => {
    register("orphan", { baseline: { root: "/workspace", files: new Map() } });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "orphan", status: "running" });
    observeRun("orphan", "run-orphan");
    removeTask("orphan");
    await stopRunObservers();
  });

  it("stops polling when a task is removed during an in-flight SDK status read", async () => {
    vi.useFakeTimers();
    register("orphan", { baseline: { root: "/workspace", files: new Map() } });
    let resolveStatus!: (status: { task_id: string; status: string }) => void;
    deriveTaskStatusMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    observeRun("orphan", "run-orphan");
    removeTask("orphan");
    resolveStatus({ task_id: "orphan", status: "running" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deriveTaskStatusMock).toHaveBeenCalledOnce();
  });

  it("stops polling when the observed run is removed but the task remains", async () => {
    vi.useFakeTimers();
    const task = register("orphan", { baseline: { root: "/workspace", files: new Map() } });
    let resolveStatus!: (status: { task_id: string; status: string }) => void;
    deriveTaskStatusMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    observeRun("orphan", "run-orphan");
    task.runs = [];
    resolveStatus({ task_id: "orphan", status: "running" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task.runs).toEqual([]);
    expect(deriveTaskStatusMock).toHaveBeenCalledOnce();
  });

  it("stops polling when the task exists without any run history", async () => {
    const task = register("orphan-history");
    task.runs = undefined;
    observeRun("orphan-history", "run-not-recorded");
    expect(task.runs).toBeUndefined();
    await stopRunObservers();
  });

  it("finalizes a no-criteria cancellation even when its baseline is unavailable", async () => {
    const task = register("cancel", { baselineError: "initial read failed" });
    const run = task.runs?.[0];
    if (!run) throw new Error("test run registration failed");
    run.cancelledAt = Date.now();
    await finishConfirmedCancellation("cancel");
    expect(run.report?.verification.state).toBe("not_requested");
    expect(run.report?.evidence.errors).toEqual(["initial read failed"]);
  });

  it("uses default empty change/check criteria and generic diagnostics on cancellation", async () => {
    const task = register("cancel-defaults");
    const run = task.runs?.[0];
    if (!run) throw new Error("test run registration failed");
    run.cancelledAt = Date.now();
    await finishConfirmedCancellation("cancel-defaults");
    expect(run.report?.diagnostics).toEqual(["workspace baseline unavailable"]);
    expect(captureReportMock).not.toHaveBeenCalled();
    const withBaseline = register("cancel-defaults", {
      baseline: { root: "/workspace", files: new Map() },
    });
    const baselineRun = withBaseline.runs?.[0];
    if (!baselineRun) throw new Error("test run registration failed");
    baselineRun.cancelledAt = Date.now();
    await finishConfirmedCancellation("cancel-defaults");
    expect(captureReportMock).toHaveBeenCalledWith(
      baselineRun.baseline,
      [],
      [],
      "cancelled",
      undefined,
    );
  });

  it("preserves a finalized report during shutdown and does not replace its cached result", async () => {
    const lease = Symbol("shutdown lease");
    const task = register("shutdown-complete", {
      report: report(),
      reportReady: true,
      executionState: "completed",
      result: {
        task_id: "shutdown-complete",
        run_id: "run-shutdown-complete",
        status: "completed",
        result: "cached text",
      },
      workspaceLease: lease,
    });
    deriveTaskStatusMock.mockResolvedValue({ task_id: "shutdown-complete", status: "running" });
    observeRun("shutdown-complete", "run-shutdown-complete");
    await stopRunObservers();
    expect(task.runs?.[0].report?.verification.state).toBe("passed");
    expect(task.runs?.[0].result?.result).toBe("cached text");
    expect(releaseWorkspaceMock).toHaveBeenCalledWith(lease);
  });

  it("retains the workspace lease and marks shutdown unavailable when check drain fails", async () => {
    abortAndDrainMock.mockResolvedValueOnce(false);
    const lease = Symbol("undrained-check");
    const task = register("shutdown-undrained", {
      baseline: { root: "/workspace", files: new Map() },
      workspaceLease: lease,
      controller: new AbortController(),
    });
    const drained = await stopRunObservers(17);
    expect(drained).toBe(false);
    expect(abortAndDrainMock).toHaveBeenCalledWith(task.runs?.[0].controller, 17);
    expect(task.runs?.[0].workspaceLease).toBe(lease);
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(task.runs?.[0].report?.diagnostics).toContain(
      "check process termination was not confirmed; workspace lease retained",
    );
    expect(releaseWorkspaceMock).not.toHaveBeenCalled();
  });

  it("retains server-specific leases while at least one check group remains unconfirmed", async () => {
    abortAndDrainMock.mockResolvedValueOnce(false);
    const lease = Symbol("server-undrained");
    const task = register("shutdown-undrained", {
      baseline: { root: "/workspace", files: new Map() },
      workspaceLease: lease,
      controller: new AbortController(),
    });
    const stopped = await stopServerObservers("server-1", 25);
    expect(stopped).toBe(false);
    expect(task.runs?.[0].workspaceLease).toBe(lease);
    expect(task.runs?.[0].report?.verification.state).toBe("unavailable");
    expect(releaseWorkspaceMock).not.toHaveBeenCalled();
  });
});

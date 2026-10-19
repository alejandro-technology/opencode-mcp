import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortAndDrainChecks,
  captureReport,
  captureWorkspace,
  compareWorkspace,
  processGroupStates,
  releaseWorkspace,
  reserveWorkspace,
  runCheck,
  signalCheckProcess,
  validateRelativeCwd,
  validateRelativePath,
  type WorkspaceSnapshot,
  waitForProcessGroupExit,
} from "../../../src/modules/shared/execution-report.js";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "execution-report-test-"));
  directories.push(directory);
  return directory;
}

function requiredLease(token: symbol | undefined): symbol {
  if (!token) throw new Error("expected workspace lease");
  return token;
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("execution report workspace evidence", () => {
  it("compares dirty baseline files, untracked files, binary data, deletions, and symlink changes", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "dirty.txt"), "already modified before dispatch");
    await writeFile(path.join(root, "delete.bin"), Buffer.from([0, 1, 255]));
    await writeFile(path.join(root, "target-a"), "a");
    await symlink("target-a", path.join(root, "pointer"));
    const before = await captureWorkspace(root);
    await writeFile(path.join(root, "dirty.txt"), "changed by this run");
    await unlink(path.join(root, "delete.bin"));
    await writeFile(path.join(root, "new.bin"), Buffer.from([0, 128, 255]));
    await unlink(path.join(root, "pointer"));
    await symlink("target-b", path.join(root, "pointer"));

    const changes = compareWorkspace(before, await captureWorkspace(root));

    expect(changes).toEqual([
      { path: "delete.bin", change: "deleted", evidence: "workspace_delta" },
      { path: "dirty.txt", change: "modified", evidence: "workspace_delta" },
      { path: "new.bin", change: "created", evidence: "workspace_delta" },
      { path: "pointer", change: "modified", evidence: "workspace_delta" },
    ]);
  });

  it("captures explicitly expected paths under ignored inventory directories", async () => {
    const root = await workspace();
    const expected = "node_modules/pkg/generated.txt";
    await mkdir(path.dirname(path.join(root, expected)), { recursive: true });
    const before = await captureWorkspace(root, [expected]);
    await writeFile(path.join(root, expected), "created");
    const after = await captureWorkspace(root, [expected]);
    expect(compareWorkspace(before, after)).toEqual([
      { path: expected, change: "created", evidence: "workspace_delta" },
    ]);
  });

  it("does not double-count expected files already in the recursive inventory", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "already.txt"), "present");
    const snapshot = await captureWorkspace(root, ["already.txt"]);
    expect(snapshot.files.has("already.txt")).toBe(true);
  });

  it("explicitly inventories symlinks and skips expected missing paths and directories", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "target"), "target");
    await symlink("target", path.join(root, "link"));
    await mkdir(path.join(root, "folder"));
    const snapshot = await captureWorkspace(root, ["link", "missing", "folder"]);
    expect(snapshot.files.has("link")).toBe(true);
    expect(snapshot.files.has("missing")).toBe(false);
  });

  it("skips .git and rejects inventories beyond the byte budget", async () => {
    const root = await workspace();
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "config"), "excluded");
    await writeFile(path.join(root, "large.bin"), Buffer.alloc(32 * 1024 * 1024 + 1));
    await expect(captureWorkspace(root)).rejects.toThrow("file inventory exceeded");
  });

  it("bounds explicitly expected files in excluded inventory directories", async () => {
    const root = await workspace();
    const expected = "node_modules/pkg/large.bin";
    await mkdir(path.dirname(path.join(root, expected)), { recursive: true });
    await writeFile(path.join(root, expected), Buffer.alloc(32 * 1024 * 1024 + 1));
    await expect(captureWorkspace(root, [expected])).rejects.toThrow("explicit files exceeded");
  });

  it("rejects paths and symlink-resolved expected files that escape the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "outside.txt"), "secret");
    await symlink(outside, path.join(root, "escape"));
    await expect(captureWorkspace(root, ["../outside.txt"])).rejects.toThrow(
      "invalid expected workspace path",
    );
    await expect(captureWorkspace(root, ["escape/outside.txt"])).rejects.toThrow(
      "resolves outside",
    );
  });

  it("marks promised no-op changes failed and analysis-only runs not_requested", async () => {
    const root = await workspace();
    const before = await captureWorkspace(root);
    const failed = await captureReport(
      before,
      [{ path: "missing.txt", change: "created" }],
      [],
      "completed",
    );
    const analysis = await captureReport(before, [], [], "completed");

    expect(failed.verification.state).toBe("failed");
    expect(failed.diagnostics).toContain("expected created: missing.txt was not observed");
    expect(failed.evidence.complete).toBe(true);
    expect(analysis.verification.state).toBe("not_requested");
  });

  it("preserves unavailable inventory errors rather than claiming an empty delta", async () => {
    const root = await workspace();
    const before = await captureWorkspace(root);
    await rm(root, { recursive: true, force: true });
    const report = await captureReport(
      before,
      [{ path: "missing.txt", change: "created" }],
      [],
      "completed",
    );
    expect(report.verification.state).toBe("unavailable");
    expect(report.evidence.complete).toBe(false);
    expect(report.evidence.errors).not.toHaveLength(0);
  });

  it("marks checks passed only when the executable succeeds and reports cancelled execution", async () => {
    const root = await workspace();
    const before = await captureWorkspace(root);
    const passed = await captureReport(
      before,
      [],
      [{ executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
      "completed",
    );
    const failed = await captureReport(
      before,
      [],
      [{ executable: process.execPath, argv: ["-e", "process.exit(3)"] }],
      "completed",
    );
    const cancelled = await captureReport(
      before,
      [{ path: "no.txt", change: "created" }],
      [],
      "cancelled",
    );
    await writeFile(path.join(root, "expected.txt"), "created");
    const exactExpected = await captureReport(
      before,
      [{ path: "expected.txt", change: "created" }],
      [],
      "completed",
    );
    const agentFailed = await captureReport(
      before,
      [{ path: "other.txt", change: "created" }],
      [],
      "failed",
    );
    const aborted = new AbortController();
    aborted.abort();
    const signalCancelled = await captureReport(
      before,
      [{ path: "other.txt", change: "created" }],
      [],
      "completed",
      aborted.signal,
    );
    expect(passed.verification.state).toBe("passed");
    expect(failed.verification.state).toBe("failed");
    expect(cancelled.verification.state).toBe("cancelled");
    expect(exactExpected.verification.state).toBe("passed");
    expect(exactExpected.diagnostics).toEqual([]);
    expect(agentFailed.verification.state).toBe("failed");
    expect(signalCancelled.verification.state).toBe("cancelled");
  });

  it("returns modified, created, and deleted differences in deterministic order", () => {
    const before = {
      root: "/workspace",
      files: new Map([
        ["a", "old"],
        ["gone", "old"],
      ]),
    };
    const after = {
      root: "/workspace",
      files: new Map([
        ["a", "new"],
        ["b", "new"],
      ]),
    };
    expect(compareWorkspace(before as WorkspaceSnapshot, after as WorkspaceSnapshot)).toEqual([
      { path: "a", change: "modified", evidence: "workspace_delta" },
      { path: "b", change: "created", evidence: "workspace_delta" },
      { path: "gone", change: "deleted", evidence: "workspace_delta" },
    ]);
  });

  it("validates expected relative paths and cwd roots without accepting traversal", () => {
    expect(validateRelativePath("src/file.ts")).toBe(true);
    expect(validateRelativePath("../secret")).toBe(false);
    expect(validateRelativePath("/absolute")).toBe(false);
    expect(validateRelativePath(".")).toBe(false);
    expect(validateRelativeCwd(".")).toBe(true);
    expect(validateRelativeCwd("")).toBe(true);
    expect(validateRelativeCwd("../../outside")).toBe(false);
  });
});

describe("verification check execution", () => {
  it("captures a successful executable's output and exit status", async () => {
    const root = await workspace();
    const result = await runCheck(
      { executable: process.execPath, argv: ["-e", "process.stdout.write('ok')"] },
      root,
    );
    expect(result).toMatchObject({
      exit_code: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      timed_out: false,
    });
  });

  it("records failure, ENOENT, and workspace-escaping cwd outcomes", async () => {
    const root = await workspace();
    const fail = await runCheck(
      { executable: process.execPath, argv: ["-e", "process.exit(7)"] },
      root,
    );
    const missing = await runCheck(
      { executable: "missing-executable-for-execution-report", argv: [] },
      root,
    );
    const outside = await runCheck(
      { executable: process.execPath, argv: [], cwd: "../outside" },
      root,
    );
    expect(fail.exit_code).toBe(7);
    expect(missing.error).toContain("ENOENT");
    expect(outside.error).toContain("outside workspace");
  });

  it("returns unavailable when the workspace root cannot be resolved", async () => {
    const result = await runCheck(
      { executable: process.execPath, argv: [] },
      "/missing/execution-report-workspace",
    );
    expect(result.error).toContain("cwd is missing");
  });

  it("rejects symlinked cwd escapes", async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, path.join(root, "external"));
    const result = await runCheck(
      { executable: process.execPath, argv: [], cwd: "external" },
      root,
    );
    expect(result.error).toContain("outside workspace");
  });

  it("times out and kills the command process group", async () => {
    const root = await workspace();
    const result = await runCheck(
      {
        executable: process.execPath,
        argv: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        timeout_ms: 500,
      },
      root,
    );
    expect(result.timed_out).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("kills descendant processes when a check times out", async () => {
    const root = await workspace();
    const script = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      "process.stdout.write(String(child.pid))",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ].join(";");
    const result = await runCheck(
      {
        executable: process.execPath,
        argv: ["-e", script],
        timeout_ms: 300,
      },
      root,
    );
    const descendant = Number(result.stdout);
    expect(result.timed_out).toBe(true);
    expect(Number.isInteger(descendant)).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(descendant, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("uses direct-child termination on Windows", async () => {
    const root = await workspace();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const result = await runCheck(
        {
          executable: process.execPath,
          argv: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          timeout_ms: 100,
        },
        root,
      );
      expect(result.timed_out).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("signals Unix process groups, handles missing PIDs, and uses taskkill for Windows trees", async () => {
    const child = { pid: 42, kill: vi.fn() };
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    await signalCheckProcess(child, false, "darwin");
    expect(killSpy).toHaveBeenCalledWith(-42, "SIGTERM");
    killSpy.mockImplementation(() => {
      throw new Error("process already exited");
    });
    expect(await signalCheckProcess(child, true, "darwin")).toBe(false);
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("process already exited"), { code: "ESRCH" });
    });
    expect(await signalCheckProcess(child, false, "darwin")).toBe(true);
    killSpy.mockRestore();

    const withoutPid = { pid: undefined, kill: vi.fn() };
    expect(await signalCheckProcess(withoutPid, false, "darwin")).toBe(false);
    expect(withoutPid.kill).toHaveBeenCalledWith("SIGTERM");

    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnKiller = vi.fn(() => killer);
    const killed = signalCheckProcess(
      child,
      true,
      "win32",
      spawnKiller as unknown as typeof import("node:child_process").spawn,
    );
    expect(spawnKiller).toHaveBeenCalledWith("taskkill.exe", ["/PID", "42", "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(killer.unref).toHaveBeenCalledOnce();
    killer.emit("error", new Error("taskkill unavailable"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(killed).resolves.toBe(false);
  });

  it("confirms a process group gone only when it is absent or contains only zombies", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw denied;
    });
    try {
      await expect(waitForProcessGroupExit(42, 20, async () => [])).resolves.toBe(true);
      await expect(waitForProcessGroupExit(42, 20, async () => ["Z"])).resolves.toBe(true);
      await expect(waitForProcessGroupExit(42, 20, async () => ["X"])).resolves.toBe(true);
      await expect(waitForProcessGroupExit(42, 20, async () => ["S"])).resolves.toBe(false);
      await expect(waitForProcessGroupExit(42, 20, async () => undefined)).resolves.toBe(false);
      killSpy.mockReturnValue(true);
      await expect(waitForProcessGroupExit(42, 20, async () => ["Z"])).resolves.toBe(true);
      await expect(waitForProcessGroupExit(42, 20, async () => ["X"])).resolves.toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("handles process-state probe errors, failed ps commands, and parsed group output", async () => {
    const failedProbe = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    const failedSpawn = vi.fn(() => failedProbe);
    const errorResult = processGroupStates(
      42,
      failedSpawn as unknown as typeof import("node:child_process").spawn,
    );
    failedProbe.emit("error", new Error("ps unavailable"));
    await expect(errorResult).resolves.toBeUndefined();

    const unsuccessfulProbe = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    const unsuccessfulSpawn = vi.fn(() => unsuccessfulProbe);
    const unsuccessfulResult = processGroupStates(
      42,
      unsuccessfulSpawn as unknown as typeof import("node:child_process").spawn,
    );
    unsuccessfulProbe.emit("close", 1);
    await expect(unsuccessfulResult).resolves.toBeUndefined();

    const successfulProbe = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    const successfulSpawn = vi.fn(() => successfulProbe);
    const successfulResult = processGroupStates(
      42,
      successfulSpawn as unknown as typeof import("node:child_process").spawn,
    );
    successfulProbe.stdout.emit("data", Buffer.from("42 S\n42 Z\n7 R\n"));
    successfulProbe.emit("close", 0);
    await expect(successfulResult).resolves.toEqual(["S", "Z"]);
  });

  it("stops waiting at the process-group termination deadline", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      await expect(waitForProcessGroupExit(42, 25, async () => ["S"])).resolves.toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("awaits a cancelled check process before reporting its signal drained", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let settled = false;
    const check = runCheck(
      {
        executable: process.execPath,
        argv: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        timeout_ms: 10_000,
      },
      root,
      controller.signal,
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const drain = abortAndDrainChecks(controller, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await expect(drain).resolves.toBe(true);
    const result = await check;
    expect(settled).toBe(true);
    expect(result.termination_confirmed).toBe(true);
    expect(result.error).toMatch(/cancelled|termination could not be confirmed/);
  });

  it("coalesces cancellation and timeout signals for one check", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const check = runCheck(
      {
        executable: process.execPath,
        argv: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        timeout_ms: 100,
      },
      root,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(check).resolves.toMatchObject({ timed_out: true, error: "check cancelled" });
  });

  it("keeps shared abort tracking until every concurrent check settles", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const results = await Promise.all([
      runCheck(
        { executable: process.execPath, argv: ["-e", "process.exit(0)"] },
        root,
        controller.signal,
      ),
      runCheck(
        { executable: process.execPath, argv: ["-e", "process.exit(0)"] },
        root,
        controller.signal,
      ),
    ]);
    expect(results.map((result) => result.exit_code)).toEqual([0, 0]);
    await expect(abortAndDrainChecks(controller, 20)).resolves.toBe(true);
  });

  it("reports a bounded drain timeout without claiming check termination", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const check = runCheck(
      {
        executable: process.execPath,
        argv: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        timeout_ms: 10_000,
      },
      root,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(abortAndDrainChecks(controller, 20)).resolves.toBe(false);
    await expect(check).resolves.toMatchObject({
      termination_confirmed: true,
      error: "check cancelled",
    });
  });

  it("bounds stdout and stderr and records exact truncation", async () => {
    const root = await workspace();
    const result = await runCheck(
      {
        executable: process.execPath,
        argv: [
          "-e",
          "process.stdout.write('x'.repeat(20000));process.stderr.write('y'.repeat(20000))",
        ],
      },
      root,
    );
    expect(Buffer.byteLength(result.stdout)).toBe(16 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBe(16 * 1024);
    expect(result.stdout_truncated).toBe(true);
    expect(result.stderr_truncated).toBe(true);
  });

  it("cancels running children and does not spawn for an already-aborted signal", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const operation = runCheck(
      {
        executable: process.execPath,
        argv: ["-e", "setInterval(()=>{},1000)"],
        timeout_ms: 10_000,
      },
      root,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);
    const cancelled = await operation;
    expect(cancelled.error).toBe("check cancelled");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(
      (await runCheck({ executable: process.execPath, argv: [] }, root, alreadyAborted.signal))
        .error,
    ).toBe("check cancelled");
  });
});

describe("workspace reservations", () => {
  it("allows shared writers and denies exclusive overlapping canonical directories", async () => {
    const root = await workspace();
    const child = path.join(root, "child");
    await mkdir(child);
    const alias = path.join(root, "alias");
    const other = path.join(root, "other");
    await symlink(root, alias);
    await mkdir(other);
    const shared = await reserveWorkspace(root, false);
    const sharedAgain = await reserveWorkspace(alias, false);
    expect(shared).toBeDefined();
    expect(sharedAgain).toBeDefined();
    expect(await reserveWorkspace(child, true)).toBeUndefined();
    releaseWorkspace(requiredLease(shared));
    releaseWorkspace(requiredLease(sharedAgain));

    const exclusive = await reserveWorkspace(child, true);
    expect(exclusive).toBeDefined();
    expect(await reserveWorkspace(root, false)).toBeUndefined();
    const siblingLease = await reserveWorkspace(other, true);
    expect(siblingLease).toBeDefined();
    releaseWorkspace(requiredLease(siblingLease));
    releaseWorkspace(requiredLease(exclusive));
    const finalLease = await reserveWorkspace(root, true);
    expect(finalLease).toBeDefined();
    releaseWorkspace(requiredLease(finalLease));
  });

  it("releases idempotently and rejects missing reservation roots", async () => {
    const root = await workspace();
    const token = await reserveWorkspace(root, true);
    releaseWorkspace(requiredLease(token));
    releaseWorkspace(Symbol("not reserved"));
    releaseWorkspace(requiredLease(token));
    await expect(reserveWorkspace(path.join(root, "missing"), false)).rejects.toThrow();
  });
});

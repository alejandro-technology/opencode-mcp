import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

export type ExpectedChange = { path: string; change: "created" | "modified" | "deleted" };
export type VerificationCheck = {
  executable: string;
  argv: string[];
  cwd?: string;
  timeout_ms?: number;
};
export type WorkspaceSnapshot = { root: string; files: Map<string, string> };
export type FileChange = ExpectedChange & { evidence: "workspace_delta" };
export type VerificationState =
  | "not_requested"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "unavailable"
  | "cancelled";
export type CheckResult = {
  executable: string;
  argv: string[];
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out?: boolean;
  termination_confirmed?: boolean;
  error?: string;
};
export type ExecutionReport = {
  changes: FileChange[];
  verification: { state: VerificationState; checks: CheckResult[]; execution_state?: string };
  diagnostics: string[];
  evidence: {
    source: "workspace_delta";
    inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths";
    complete: boolean;
    errors: string[];
    attribution: "uncertain_shared_workspace";
  };
};

const MAX_FILES = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;

function insideWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** @internal Signal a direct check child and its descendants without invoking a shell. */
export function signalCheckProcess(
  child: Pick<ChildProcess, "pid" | "kill">,
  force: boolean,
  platform = process.platform,
  spawnKiller: typeof spawn = spawn,
): Promise<boolean> {
  const signalName = force ? "SIGKILL" : "SIGTERM";
  const childPid = child.pid;
  if (platform === "win32" && childPid) {
    return new Promise((resolve) => {
      const killer = spawnKiller(
        "taskkill.exe",
        ["/PID", String(childPid), "/T", ...(force ? ["/F"] : [])],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => {
        child.kill(signalName);
        resolve(false);
      });
      killer.once("close", (code) => resolve(code === 0));
      killer.unref();
    });
  }
  if (childPid) {
    try {
      process.kill(-childPid, signalName);
    } catch (error) {
      if (force && error instanceof Error && "code" in error && error.code === "ESRCH")
        return Promise.resolve(true);
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        return Promise.resolve(false);
    }
    return force ? waitForProcessGroupExit(childPid) : Promise.resolve(true);
  }
  child.kill(signalName);
  return Promise.resolve(false);
}

const activeChecks = new WeakMap<AbortSignal, Set<Promise<boolean>>>();

/** Abort in-flight checks and wait until every check process has drained or the deadline expires. */
export async function abortAndDrainChecks(
  controller: AbortController,
  timeoutMs = 5_000,
): Promise<boolean> {
  controller.abort(new Error("workspace execution is stopping"));
  const checks = [...(activeChecks.get(controller.signal) ?? [])];
  if (checks.length === 0) return true;
  let resolveTimeout!: (drained: boolean) => void;
  const timeout = new Promise<boolean>((resolve) => {
    resolveTimeout = resolve;
  });
  const timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([
      Promise.all(checks).then((confirmations) => confirmations.every(Boolean)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @internal Confirm process-group termination, with an injectable state probe for tests. */
export async function waitForProcessGroupExit(
  pid: number,
  timeoutMs = 2_000,
  readStates: (groupId: number) => Promise<string[] | undefined> = processGroupStates,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      const states = await readStates(pid);
      if (
        states &&
        (states.length === 0 ||
          states.every((state) => state.startsWith("Z") || state.startsWith("X")))
      )
        return true;
      return false;
    }
    const states = await readStates(pid);
    if (
      states &&
      states.length > 0 &&
      states.every((state) => state.startsWith("Z") || state.startsWith("X"))
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** @internal Read process-group states, with an injectable spawner for failure-path tests. */
export async function processGroupStates(
  groupId: number,
  spawnProcess: typeof spawn = spawn,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const ps = spawnProcess("ps", ["-axo", "pgid=,stat="], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    ps.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    ps.once("error", () => resolve(undefined));
    ps.once("close", (code) => {
      if (code !== 0) return resolve(undefined);
      const states = output.split("\n").flatMap((line) => {
        const [pidText, state] = line.trim().split(/\s+/);
        return Number(pidText) === groupId && state ? [state] : [];
      });
      resolve(states);
    });
  });
}

export function validateRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..") &&
    value !== "."
  );
}

export function validateRelativeCwd(value: string): boolean {
  return value === "." || value === "" || validateRelativePath(value);
}

async function walk(
  root: string,
  dir = root,
  result = new Map<string, string>(),
  budget = { bytes: 0 },
): Promise<Map<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (result.size >= MAX_FILES) throw new Error(`file inventory exceeded ${MAX_FILES} entries`);
    const info = await lstat(full);
    if (info.isDirectory()) await walk(root, full, result, budget);
    else {
      if (!info.isSymbolicLink() && budget.bytes + info.size > MAX_BYTES)
        throw new Error(`file inventory exceeded ${MAX_BYTES} bytes`);
      const content = info.isSymbolicLink()
        ? `symlink:${await readlink(full)}`
        : await readFile(full);
      budget.bytes += typeof content === "string" ? Buffer.byteLength(content) : content.length;
      if (budget.bytes > MAX_BYTES) throw new Error(`file inventory exceeded ${MAX_BYTES} bytes`);
      result.set(rel, createHash("sha256").update(content).digest("hex"));
    }
  }
  return result;
}

export async function captureWorkspace(
  directory: string,
  explicitPaths: string[] = [],
): Promise<WorkspaceSnapshot> {
  const root = await realpath(directory);
  const files = await walk(root);
  let explicitBytes = 0;
  for (const relative of explicitPaths) {
    if (!validateRelativePath(relative))
      throw new Error(`invalid expected workspace path: ${relative}`);
    const full = path.resolve(root, relative);
    const info = await lstat(full).catch(() => undefined);
    if (!info || info.isDirectory()) continue;
    const alreadyInventoried = files.has(relative);
    if (!info.isSymbolicLink() && !alreadyInventoried && explicitBytes + info.size > MAX_BYTES)
      throw new Error(`explicit files exceeded ${MAX_BYTES} bytes`);
    let content: string | Buffer;
    if (!info.isSymbolicLink()) {
      const canonicalFile = await realpath(full);
      if (!insideWorkspace(root, canonicalFile))
        throw new Error(`expected workspace path resolves outside the workspace: ${relative}`);
      if (!alreadyInventoried) explicitBytes += info.size;
      content = await readFile(full);
    } else content = `symlink:${await readlink(full)}`;
    files.set(relative, createHash("sha256").update(content).digest("hex"));
  }
  return { root, files };
}

export function compareWorkspace(
  before: Awaited<ReturnType<typeof captureWorkspace>>,
  after: Awaited<ReturnType<typeof captureWorkspace>>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [file, hash] of after.files) {
    const old = before.files.get(file);
    if (old !== hash)
      changes.push({
        path: file,
        change: old === undefined ? "created" : "modified",
        evidence: "workspace_delta",
      });
  }
  for (const file of before.files.keys())
    if (!after.files.has(file))
      changes.push({ path: file, change: "deleted", evidence: "workspace_delta" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runCheck(
  check: VerificationCheck,
  workspace: string,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  const canonicalWorkspace = await realpath(workspace).catch(() => "");
  const cwd = check.cwd ? path.resolve(canonicalWorkspace, check.cwd) : canonicalWorkspace;
  const canonical = await realpath(cwd).catch(() => "");
  if (!canonicalWorkspace || !canonical || !insideWorkspace(canonicalWorkspace, canonical)) {
    return {
      executable: check.executable,
      argv: check.argv,
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - started,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      error: "check cwd is missing or outside workspace",
    };
  }
  if (signal?.aborted) {
    return {
      executable: check.executable,
      argv: check.argv,
      exit_code: null,
      signal: null,
      duration_ms: Date.now() - started,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      error: "check cancelled",
    };
  }
  let resolveDrain!: (terminated: boolean) => void;
  const drained = new Promise<boolean>((resolve) => {
    resolveDrain = resolve;
  });
  if (signal) {
    const checks = activeChecks.get(signal) ?? new Set<Promise<boolean>>();
    checks.add(drained);
    activeChecks.set(signal, checks);
  }
  return new Promise((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let termination: Promise<boolean> | undefined;
    const child = spawn(check.executable, check.argv, {
      cwd: canonical,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (termination) return;
      termination = (async () => {
        const graceful = await signalCheckProcess(child, false);
        if (graceful) {
          await new Promise((resolve) => {
            killTimer = setTimeout(resolve, 250);
            killTimer.unref?.();
          });
        }
        killTimer = undefined;
        return signalCheckProcess(child, true);
      })();
      void termination.then((confirmed) => {
        if (closeResult) finish(closeResult.code, closeResult.signal, undefined, confirmed);
      });
    };
    const append = (
      target: Buffer,
      chunk: Buffer,
      set: (value: Buffer) => void,
      truncated: () => void,
    ) => {
      const combined = Buffer.concat([target, chunk]);
      if (combined.length > MAX_OUTPUT_BYTES) truncated();
      set(combined.subarray(-MAX_OUTPUT_BYTES));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      append(
        stdout,
        chunk,
        (value) => {
          stdout = value;
        },
        () => {
          stdoutTruncated = true;
        },
      );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(
        stderr,
        chunk,
        (value) => {
          stderr = value;
        },
        () => {
          stderrTruncated = true;
        },
      );
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, check.timeout_ms ?? 30_000);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (
      code: number | null,
      closeSignal: NodeJS.Signals | null,
      error?: Error,
      terminationConfirmed?: boolean,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      killTimer = undefined;
      signal?.removeEventListener("abort", onAbort);
      if (signal) {
        const checks = activeChecks.get(signal);
        checks?.delete(drained);
        if (checks?.size === 0) activeChecks.delete(signal);
      }
      resolveDrain(terminationConfirmed !== false);
      resolve({
        executable: check.executable,
        argv: check.argv,
        exit_code: code,
        signal: closeSignal,
        duration_ms: Date.now() - started,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        timed_out: timedOut,
        ...(terminationConfirmed === undefined
          ? {}
          : { termination_confirmed: terminationConfirmed }),
        ...(cancelled ? { error: "check cancelled" } : {}),
        ...(terminationConfirmed === false
          ? { error: "check process termination could not be confirmed" }
          : {}),
        ...(error ? { error: error.message } : {}),
      });
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, closeSignal) => {
      closeResult = { code, signal: closeSignal };
      if (termination) {
        void termination.then((confirmed) => finish(code, closeSignal, undefined, confirmed));
      } else finish(code, closeSignal);
    });
  });
}

const reservations: Array<{ root: string; exclusive: boolean; token: symbol }> = [];
export async function reserveWorkspace(
  directory: string,
  exclusive: boolean,
): Promise<symbol | undefined> {
  const root = await realpath(directory);
  const overlap = (a: string, b: string) =>
    a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
  if (reservations.some((item) => overlap(root, item.root) && (exclusive || item.exclusive)))
    return undefined;
  const token = Symbol(root);
  reservations.push({ root, exclusive, token });
  return token;
}
export function releaseWorkspace(token: symbol): void {
  const index = reservations.findIndex((item) => item.token === token);
  if (index >= 0) reservations.splice(index, 1);
}

export async function captureReport(
  before: Awaited<ReturnType<typeof captureWorkspace>>,
  expected: ExpectedChange[],
  checks: VerificationCheck[],
  execution: string,
  signal?: AbortSignal,
): Promise<ExecutionReport> {
  const errors: string[] = [];
  let changes: FileChange[] = [];
  try {
    changes = compareWorkspace(
      before,
      await captureWorkspace(
        before.root,
        expected.map((item) => item.path),
      ),
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const results: CheckResult[] = [];
  if (execution !== "cancelled")
    for (const check of checks) results.push(await runCheck(check, before.root, signal));
  const missing = expected.filter(
    (item) => !changes.some((actual) => actual.path === item.path && actual.change === item.change),
  );
  const checksPassed = results.every(
    (result) => result.exit_code === 0 && result.timed_out !== true && !result.error,
  );
  const state = errors.length
    ? "unavailable"
    : execution === "cancelled" || signal?.aborted
      ? "cancelled"
      : execution !== "completed"
        ? "failed"
        : checksPassed && missing.length === 0
          ? "passed"
          : "failed";
  return {
    changes,
    verification: {
      state: checks.length || expected.length ? state : "not_requested",
      checks: results,
    },
    diagnostics: [
      ...errors,
      ...missing.map((item) => `expected ${item.change}: ${item.path} was not observed`),
    ],
    evidence: {
      source: "workspace_delta",
      inventory_scope: "recursive_except_git_and_node_modules_plus_explicit_paths",
      complete: errors.length === 0,
      errors,
      attribution: "uncertain_shared_workspace",
    },
  };
}

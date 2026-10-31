import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureParent = tmpdir();
const model = process.env.OPENCODE_MCP_SMOKE_MODEL ?? "openai/gpt-6-luna";
const timeoutMs = 600_000;

type RpcReply = { id?: number; result?: unknown; error?: { code: number; message: string } };

async function findFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("failed to reserve smoke server port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function main() {
  const deadline = Date.now() + timeoutMs;
  const fixture = await mkdtemp(path.join(fixtureParent, "opencode-mcp-smoke-"));
  const workspaceCache = path.join(fixture, "managed-worktrees");
  await mkdir(workspaceCache, { recursive: true });
  const sourceMode = process.argv.includes("--source");
  const entrypoint = sourceMode
    ? path.join(repository, "src/index.ts")
    : path.join(repository, "build/src/index.js");
  const child = spawn(
    sourceMode ? "pnpx" : process.execPath,
    sourceMode ? ["tsx", entrypoint] : [entrypoint],
    {
      cwd: sourceMode ? repository : fixture,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        OPENCODE_MCP_WORKSPACE_DIR: workspaceCache,
        OPENCODE_MCP_EXTERNAL_DIR: "read-only",
      },
    },
  );
  let id = 0;
  const waiting = new Map<
    number,
    { resolve: (reply: RpcReply) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let reply: RpcReply;
    try {
      reply = JSON.parse(line) as RpcReply;
    } catch {
      return;
    }
    if (reply.id === undefined) return;
    const waiter = waiting.get(reply.id);
    if (!waiter) return;
    waiting.delete(reply.id);
    waiter.resolve(reply);
  });
  const send = (method: string, params?: unknown, timeout = timeoutMs): Promise<unknown> => {
    if (Date.now() >= deadline) return Promise.reject(new Error("overall smoke duration exceeded"));
    const boundedTimeout = Math.min(timeout, deadline - Date.now());
    const requestId = ++id;
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, boundedTimeout);
      waiting.set(requestId, {
        resolve: (reply) => {
          clearTimeout(timer);
          if (reply.error) reject(new Error(`${reply.error.code}: ${reply.error.message}`));
          else resolve(reply.result);
        },
        reject,
      });
    });
  };
  const call = async (name: string, args: Record<string, unknown>, timeout = timeoutMs) => {
    const result = (await send("tools/call", { name, arguments: args }, timeout)) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    const text = result.content?.find((part) => part.text)?.text ?? "{}";
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (result.isError) throw new Error(`${name}: ${text}`);
    return payload;
  };
  const callAllowError = async (name: string, args: Record<string, unknown>) => {
    const result = (await send("tools/call", { name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    const text = result.content?.find((part) => part.text)?.text ?? "{}";
    return JSON.parse(text) as Record<string, unknown>;
  };

  try {
    await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode-mcp-smoke", version: "1.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const started = await call("opencode_start_server", {
      port: await findFreePort(),
      directory: fixture,
    });
    const serverId = String(started.server_id ?? "");
    if (!serverId) throw new Error(`server did not start: ${JSON.stringify(started)}`);
    const invalidModel = await callAllowError("opencode_start_task", {
      server_id: serverId,
      model: "__opencode_mcp_invalid_provider__/__opencode_mcp_invalid_model__",
      prompt: "This must be rejected before dispatch and never invoke a model.",
    });
    const invalidAgent = await callAllowError("opencode_start_task", {
      server_id: serverId,
      agent: "__opencode_mcp_invalid_agent__",
      prompt: "This must be rejected before dispatch and never invoke a model.",
    });
    const contractPassed =
      invalidModel.status === "unknown_model" && invalidAgent.status === "unknown_agent";
    if (process.argv.includes("--contract-only") || process.argv.includes("--message-id-only")) {
      console.log(
        JSON.stringify(
          {
            invalid_model_status: invalidModel.status,
            invalid_agent_status: invalidAgent.status,
            passed: contractPassed,
          },
          null,
          2,
        ),
      );
      await call("opencode_stop_server", { server_id: serverId });
      if (!contractPassed) throw new Error("OpenCode model/agent validation contract changed");
      return;
    }
    if (!contractPassed) throw new Error("OpenCode rejected-model/agent contract failed");
    const agents = (await call("opencode_list_agents", { server_id: serverId })) as {
      models?: {
        providers?: Array<{ provider?: string; models?: Array<{ id?: string }> }>;
      };
    };
    const modelRefs = (agents.models?.providers ?? []).flatMap(
      (provider: { provider?: string; models?: Array<{ id?: string }> }) =>
        (provider.models ?? []).map((item) => `${provider.provider}/${item.id}`),
    );
    if (!modelRefs.includes(model))
      throw new Error(`required exact model ${model} is unavailable: ${modelRefs.join(", ")}`);

    const target = "phase2-smoke-created.txt";
    const countFile = "phase2-smoke-check-count.txt";
    const start = await call("opencode_start_task", {
      server_id: serverId,
      model,
      agent: "build",
      prompt: `Create ${target} with exactly the text "execution report smoke". Do not change any other file. Reply when saved.`,
      expected_changes: [{ path: target, change: "created" }],
      checks: [
        {
          executable: process.execPath,
          argv: [
            "-e",
            `const fs=require('fs');const p='${countFile}';const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):'0')+1;fs.writeFileSync(p,String(n));if(!fs.existsSync('${target}'))process.exit(1)`,
          ],
          timeout_ms: 10_000,
        },
      ],
    });
    const taskId = String(start.task_id ?? "");
    if (!taskId) throw new Error(`task dispatch failed: ${JSON.stringify(start)}`);
    const waited = await call(
      "opencode_wait_for_task",
      {
        task_ids: [taskId],
        mode: "all",
        until: "report",
        timeout_ms: 210_000,
        poll_interval_ms: 750,
      },
      220_000,
    );
    const first = await call("opencode_get_task_result", { task_id: taskId });
    const second = await call("opencode_get_task_result", { task_id: taskId });
    const count = await readFile(path.join(fixture, countFile), "utf8").catch(() => "missing");
    const targetContents = await readFile(path.join(fixture, target), "utf8").catch(
      () => "missing",
    );
    const firstSerialized = JSON.stringify(first);
    const secondSerialized = JSON.stringify(second);
    const usage = first.usage as
      | {
          snapshot_kind?: string;
          report?: {
            currency?: unknown;
            scope?: { descendants_included?: boolean; subagent_sessions_included?: boolean };
            run?: { message_count?: number; reported_cost?: { value?: number | null } } | null;
            session?: { message_count?: number; breakdown?: unknown[] };
          } | null;
        }
      | undefined;
    const usagePassed =
      usage?.snapshot_kind === "run_finalization" &&
      usage.report?.currency === null &&
      usage.report.scope?.descendants_included === false &&
      usage.report.scope.subagent_sessions_included === false &&
      (usage.report.run?.message_count ?? 0) > 0 &&
      typeof usage.report.run?.reported_cost?.value === "number" &&
      (usage.report.session?.message_count ?? 0) > 0 &&
      (usage.report.session?.breakdown?.length ?? 0) > 0;
    const passed =
      firstSerialized === secondSerialized &&
      usagePassed &&
      count === "1" &&
      targetContents.trimEnd() === "execution report smoke";
    if (!passed)
      throw new Error(
        `initial execution-report smoke failed: ${JSON.stringify({ waited, first, count, targetContents })}`,
      );
    const firstRunId = String(start.run_id ?? "");
    const continuation = await call("opencode_continue_task", {
      task_id: taskId,
      model,
      agent: "build",
      prompt: "Do not edit or create any file. Reply with exactly NO_CHANGE.",
      expected_changes: [{ path: "phase2-smoke-must-not-exist.txt", change: "created" }],
      checks: [
        { executable: process.execPath, argv: ["-e", "process.exit(7)"], timeout_ms: 10_000 },
      ],
    });
    const failedWait = await call(
      "opencode_wait_for_task",
      {
        task_ids: [taskId],
        mode: "all",
        until: "report",
        timeout_ms: 60_000,
        poll_interval_ms: 750,
      },
      70_000,
    );
    const failedResult = await call("opencode_get_task_result", { task_id: taskId });
    const historicResult = await call("opencode_get_task_result", {
      task_id: taskId,
      run_id: firstRunId,
    });
    const failed =
      (failedResult.verification as { state?: string } | undefined)?.state === "failed" &&
      JSON.stringify(historicResult) === firstSerialized;
    const lateWriteTarget = "phase2-smoke-cancelled-file.txt";
    const cancellationRun = await call("opencode_continue_task", {
      task_id: taskId,
      model,
      agent: "build",
      prompt: `Do not edit any files before the sleep. Use the bash tool to sleep for 20 seconds, then create ${lateWriteTarget} with exactly the text "late write". Reply only after the file is saved.`,
      expected_changes: [{ path: lateWriteTarget, change: "created" }],
    });
    const cancellation = await call("opencode_cancel_task", { task_id: taskId });
    const cancellationWait = await call(
      "opencode_wait_for_task",
      {
        task_ids: [taskId],
        mode: "all",
        until: "report",
        timeout_ms: 60_000,
        poll_interval_ms: 750,
      },
      70_000,
    );
    const cancellationResult = await call("opencode_get_task_result", { task_id: taskId });
    const lateWriteBeforeSettle = await readFile(path.join(fixture, lateWriteTarget), "utf8").catch(
      () => "missing",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const lateWriteAfterSettle = await readFile(path.join(fixture, lateWriteTarget), "utf8").catch(
      () => "missing",
    );
    const cancelled =
      cancellation.status === "cancelled" &&
      (cancellationResult.verification as { state?: string } | undefined)?.state === "cancelled" &&
      lateWriteBeforeSettle === "missing" &&
      lateWriteAfterSettle === "missing";

    const gitSource = path.join(fixture, "worktree-source");
    const nestedSource = path.join(gitSource, "packages", "app");
    await mkdir(nestedSource, { recursive: true });
    await writeFile(path.join(nestedSource, "shared.txt"), "committed base\n");
    execFileSync("git", ["init", "-q", gitSource]);
    execFileSync("git", ["-C", gitSource, "add", "."]);
    execFileSync("git", [
      "-C",
      gitSource,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "worktree smoke fixture",
    ]);
    const baseCommit = execFileSync("git", ["-C", gitSource, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await writeFile(path.join(nestedSource, "shared.txt"), "source dirty sentinel\n");
    await writeFile(path.join(nestedSource, "untracked-source.txt"), "preserve this\n");
    const worktreeStart = async (content: string, readExternal = false) =>
      call("opencode_start_task", {
        server_id: serverId,
        directory: path.relative(fixture, nestedSource),
        workspace_mode: "worktree",
        base_ref: baseCommit,
        model,
        agent: "build",
        prompt: `${readExternal ? `First read the external source file ${path.join(nestedSource, "shared.txt")} and report its exact contents in your final response. That external file is READ-ONLY and is NOT the file to modify. ` : ""}Your session working directory is a managed worktree. Read ./shared.txt in that working directory, then replace its ENTIRE contents with ${JSON.stringify(content)}. Edit only this worktree-relative ./shared.txt, never the external source file. Do not append or change any other file. Reply after the edit.`,
        expected_changes: [{ path: "shared.txt", change: "modified" }],
      });
    const [worktreeOne, worktreeTwo] = await Promise.all([
      worktreeStart("first isolated worktree\n", true),
      worktreeStart("second isolated worktree\n"),
    ]);
    const worktreeOneId = String(worktreeOne.task_id ?? "");
    const worktreeTwoId = String(worktreeTwo.task_id ?? "");
    if (!worktreeOneId || !worktreeTwoId) throw new Error("managed worktree task did not dispatch");
    const [worktreeOneWait, worktreeTwoWait] = await Promise.all([
      call(
        "opencode_wait_for_task",
        {
          task_ids: [worktreeOneId],
          mode: "all",
          until: "report",
          timeout_ms: 210_000,
          poll_interval_ms: 750,
        },
        220_000,
      ),
      call(
        "opencode_wait_for_task",
        {
          task_ids: [worktreeTwoId],
          mode: "all",
          until: "report",
          timeout_ms: 210_000,
          poll_interval_ms: 750,
        },
        220_000,
      ),
    ]);
    const worktreeOneInitial = await call("opencode_get_task_result", { task_id: worktreeOneId });
    const firstWorkspace = worktreeOne.workspace as {
      workspace_id: string;
      base_commit: string;
      source_dirty: boolean;
      source_directory: string;
      execution_directory: string;
    };
    const secondWorkspace = worktreeTwo.workspace as {
      workspace_id: string;
      execution_directory: string;
    };
    const worktreeOnePath = firstWorkspace.execution_directory;
    const worktreeTwoPath = secondWorkspace.execution_directory;
    const worktreeOneContents = await readFile(path.join(worktreeOnePath, "shared.txt"), "utf8");
    const worktreeTwoContents = await readFile(path.join(worktreeTwoPath, "shared.txt"), "utf8");
    const continuationContents = "continued worktree content\n";
    const continuationWorktree = await call("opencode_continue_task", {
      task_id: worktreeOneId,
      model,
      agent: "build",
      prompt: `Read ./shared.txt in your session working directory (the managed worktree), then replace its ENTIRE contents with ${JSON.stringify(continuationContents)}. Do not append, edit the external source file, or change any other file.`,
      expected_changes: [{ path: "shared.txt", change: "modified" }],
    });
    const worktreeContinuationWait = await call(
      "opencode_wait_for_task",
      {
        task_ids: [worktreeOneId],
        mode: "all",
        until: "report",
        timeout_ms: 90_000,
        poll_interval_ms: 750,
      },
      100_000,
    );
    const worktreeOneFinal = await call("opencode_get_task_result", { task_id: worktreeOneId });
    const worktreeContinuationContents = await readFile(
      path.join(worktreeOnePath, "shared.txt"),
      "utf8",
    );
    const dirtyCleanupOne = await callAllowError("opencode_cleanup_workspace", {
      workspace_id: firstWorkspace.workspace_id,
    });
    const cleanupOne = await call("opencode_cleanup_workspace", {
      workspace_id: firstWorkspace.workspace_id,
      discard_changes: true,
    });
    const dirtyCleanupTwo = await callAllowError("opencode_cleanup_workspace", {
      workspace_id: secondWorkspace.workspace_id,
    });
    const cleanupTwo = await call("opencode_cleanup_workspace", {
      workspace_id: secondWorkspace.workspace_id,
      discard_changes: true,
    });
    const cachedAfterCleanup = await call("opencode_get_task_result", {
      task_id: worktreeOneId,
      run_id: String(worktreeOneInitial.run_id),
    });
    const sourceAfterCleanup = await readFile(path.join(nestedSource, "shared.txt"), "utf8");
    const sourceUntrackedAfterCleanup = await readFile(
      path.join(nestedSource, "untracked-source.txt"),
      "utf8",
    );
    const worktreeSmokePassed =
      firstWorkspace.workspace_id !== secondWorkspace.workspace_id &&
      firstWorkspace.base_commit === baseCommit &&
      firstWorkspace.source_dirty === true &&
      worktreeOneContents === "first isolated worktree\n" &&
      worktreeTwoContents === "second isolated worktree\n" &&
      worktreeContinuationContents === continuationContents &&
      worktreeOneInitial.status === "completed" &&
      String(worktreeOneInitial.result).includes("source dirty sentinel") &&
      (worktreeOneInitial.usage as { snapshot_kind?: string } | undefined)?.snapshot_kind ===
        "run_finalization" &&
      (continuationWorktree.workspace as { workspace_id: string }).workspace_id ===
        firstWorkspace.workspace_id &&
      (worktreeOneFinal.workspace as { workspace_id: string }).workspace_id ===
        firstWorkspace.workspace_id &&
      dirtyCleanupOne.status === "dirty" &&
      cleanupOne.status === "removed" &&
      dirtyCleanupTwo.status === "dirty" &&
      cleanupTwo.status === "removed" &&
      (cachedAfterCleanup.workspace as { state: string }).state === "removed" &&
      (cachedAfterCleanup.usage as { snapshot_kind?: string } | undefined)?.snapshot_kind ===
        "run_finalization" &&
      sourceAfterCleanup === "source dirty sentinel\n" &&
      sourceUntrackedAfterCleanup === "preserve this\n";
    console.log(
      JSON.stringify(
        {
          model,
          server_id: serverId,
          task_id: taskId,
          run_id: start.run_id,
          wait: waited,
          first_result: first,
          repeated_result_identical: firstSerialized === secondSerialized,
          usage_snapshot_verified: usagePassed,
          check_execution_count: count,
          fixture_file_contents: targetContents,
          passed,
          failed_no_change: {
            run_id: continuation.run_id,
            wait: failedWait,
            result: failedResult,
            historical_first_run_still_cached: JSON.stringify(historicResult) === firstSerialized,
            passed: failed,
          },
          cancelled_run: {
            run_id: cancellationRun.run_id,
            cancel: cancellation,
            wait: cancellationWait,
            result: cancellationResult,
            late_write_before_settle: lateWriteBeforeSettle,
            late_write_after_settle: lateWriteAfterSettle,
            passed: cancelled,
          },
          managed_worktrees: {
            task_ids: [worktreeOneId, worktreeTwoId],
            workspace_ids: [firstWorkspace.workspace_id, secondWorkspace.workspace_id],
            base_commit: baseCommit,
            source_directory: firstWorkspace.source_directory,
            execution_directories: [worktreeOnePath, worktreeTwoPath],
            source_dirty: firstWorkspace.source_dirty,
            shared_relative_file_contents: [worktreeOneContents, worktreeTwoContents],
            first_run_result_includes_scoped_external_read: String(
              worktreeOneInitial.result,
            ).includes("source dirty sentinel"),
            usage_snapshot_kind: (
              worktreeOneInitial.usage as { snapshot_kind?: string } | undefined
            )?.snapshot_kind,
            waits: [worktreeOneWait, worktreeTwoWait, worktreeContinuationWait],
            continuation_workspace_id: (continuationWorktree.workspace as { workspace_id: string })
              .workspace_id,
            continuation_result: worktreeOneFinal,
            continuation_file_contents: worktreeContinuationContents,
            dirty_cleanup_refusals: [dirtyCleanupOne.status, dirtyCleanupTwo.status],
            explicit_cleanup: [cleanupOne.status, cleanupTwo.status],
            cached_historical_result_after_cleanup: cachedAfterCleanup,
            source_after_cleanup: {
              tracked: sourceAfterCleanup,
              untracked: sourceUntrackedAfterCleanup,
            },
            passed: worktreeSmokePassed,
          },
        },
        null,
        2,
      ),
    );
    await call("opencode_stop_server", { server_id: serverId });
    if (!passed || !failed || !cancelled || !contractPassed || !worktreeSmokePassed)
      process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    await rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

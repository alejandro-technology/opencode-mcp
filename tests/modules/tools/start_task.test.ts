import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

vi.mock("node:crypto", () => ({
  randomUUID: () => "generated-task-id",
}));

const { registerOpencodeStartTask } = await import("../../../src/modules/tools/start_task.js");
const { registerServer, killAllServers } = await import(
  "../../../src/modules/shared/server-registry.js"
);

describe("opencode_start_task", () => {
  beforeEach(() => {
    killAllServers();
  });

  it("returns server_not_found for an unknown server", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "missing", prompt: "do stuff" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "missing", status: "server_not_found" }),
        },
      ],
    });
  });

  it("returns invalid_model when model is malformed", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi", model: "no-slash" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          }),
        },
      ],
    });
  });

  it("returns invalid_model when the slash is at position 0 or end", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi", model: "/trailing" });
    expect(result).toMatchObject({ isError: true });

    const result2 = await handler({ server_id: "srv-1", prompt: "hi", model: "leading/" });
    expect(result2).toMatchObject({ isError: true });
  });

  it("requires worktree mode for base_ref and rejects non-directory selections", async () => {
    registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();
    expect(
      JSON.parse(
        (await handler({ server_id: "srv-1", prompt: "bad base", base_ref: "HEAD" })).content[0]
          .text,
      ).status,
    ).toBe("base_ref_requires_worktree");
    const file = path.join(os.tmpdir(), `not-directory-${Date.now()}`);
    await writeFile(file, "file");
    expect(
      JSON.parse(
        (await handler({ server_id: "srv-1", prompt: "bad directory", directory: file })).content[0]
          .text,
      ).status,
    ).toBe("invalid_directory");
    await rm(file, { force: true });
    const missing = path.join(os.tmpdir(), `missing-directory-${Date.now()}`);
    expect(
      JSON.parse(
        (await handler({ server_id: "srv-1", prompt: "missing", directory: missing })).content[0]
          .text,
      ).status,
    ).toBe("invalid_directory");
    const loopDirectory = await mkdtemp(path.join(os.tmpdir(), "directory-symlink-loop-"));
    const firstLink = path.join(loopDirectory, "first");
    const secondLink = path.join(loopDirectory, "second");
    await symlink(secondLink, firstLink);
    await symlink(firstLink, secondLink);
    const loopResult = await handler({ server_id: "srv-1", prompt: "loop", directory: firstLink });
    expect(JSON.parse(loopResult.content[0].text)).toMatchObject({ status: "error" });
    await rm(loopDirectory, { recursive: true, force: true });
  });

  it("returns the owned workspace id when cleanup or session registration cannot proceed", async () => {
    const workspace = {
      workspace_id: "retained-workspace",
      mode: "worktree",
      source_directory: process.cwd(),
      execution_directory: process.cwd(),
      managed: true,
      base_commit: "fixture-commit",
      source_dirty: false,
      state: "active",
    };
    const managerPath = "../../../src/modules/shared/workspace-manager.js";
    vi.doMock(managerPath, () => ({
      createManagedWorkspace: vi.fn().mockResolvedValue(workspace),
      acquireManagedWorkspaceDispatch: () => undefined,
    }));
    vi.resetModules();
    let mod = await import("../../../src/modules/tools/start_task.js");
    let registry = await import("../../../src/modules/shared/server-registry.js");
    registry.registerServer({
      serverId: "unavailable-workspace-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    let fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const unavailable = await fake.getHandler()({
      server_id: "unavailable-workspace-server",
      prompt: "test",
      workspace_mode: "worktree",
    });
    expect(JSON.parse(unavailable.content[0].text)).toMatchObject({
      status: "workspace_unavailable",
      workspace_id: workspace.workspace_id,
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();

    vi.doMock(managerPath, () => ({
      createManagedWorkspace: vi.fn().mockResolvedValue(workspace),
      acquireManagedWorkspaceDispatch: () => () => {},
      registerManagedWorkspaceSession: () => false,
      sharedWorkspaceMetadata: () => workspace,
    }));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }) },
      }),
    }));
    vi.resetModules();
    const retry = await import("../../../src/modules/tools/start_task.js");
    const retryRegistry = await import("../../../src/modules/shared/server-registry.js");
    retryRegistry.registerServer({
      serverId: "session-workspace-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const retryFake = createFakeMcpServer();
    retry.registerOpencodeStartTask(retryFake.server);
    const sessionUnavailable = await retryFake.getHandler()({
      server_id: "session-workspace-server",
      prompt: "test",
      workspace_mode: "worktree",
    });
    expect(JSON.parse(sessionUnavailable.content[0].text)).toMatchObject({
      status: "workspace_unavailable",
      workspace_id: workspace.workspace_id,
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();

    vi.doMock(managerPath, () => ({
      createManagedWorkspace: vi.fn().mockResolvedValue(workspace),
      acquireManagedWorkspaceDispatch: () => () => {},
      sharedWorkspaceMetadata: () => ({
        ...workspace,
        workspace_id: undefined,
        mode: "shared",
        managed: false,
      }),
    }));
    vi.doMock("../../../src/modules/shared/opencode-client.js", () => ({
      clientForServer: () => undefined,
      sdkResponseError: () => undefined,
    }));
    vi.resetModules();
    mod = await import("../../../src/modules/tools/start_task.js");
    registry = await import("../../../src/modules/shared/server-registry.js");
    registry.registerServer({
      serverId: "early-client-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const noClient = await fake.getHandler()({
      server_id: "early-client-server",
      prompt: "no client",
    });
    expect(JSON.parse(noClient.content[0].text)).toMatchObject({ status: "server_not_found" });
    const noWorktreeClient = await fake.getHandler()({
      server_id: "early-client-server",
      prompt: "no worktree client",
      workspace_mode: "worktree",
    });
    expect(JSON.parse(noWorktreeClient.content[0].text)).toMatchObject({
      status: "server_not_found",
      workspace_id: workspace.workspace_id,
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("../../../src/modules/shared/opencode-client.js");
    vi.resetModules();

    vi.doMock(managerPath, () => ({
      createManagedWorkspace: vi.fn().mockResolvedValue(workspace),
      acquireManagedWorkspaceDispatch: () => () => {},
    }));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: { create: vi.fn().mockRejectedValue(new Error("worktree backend failed")) },
      }),
    }));
    vi.resetModules();
    mod = await import("../../../src/modules/tools/start_task.js");
    registry = await import("../../../src/modules/shared/server-registry.js");
    registry.registerServer({
      serverId: "worktree-error-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const worktreeError = await fake.getHandler()({
      server_id: "worktree-error-server",
      prompt: "fail create",
      workspace_mode: "worktree",
    });
    expect(JSON.parse(worktreeError.content[0].text)).toMatchObject({
      status: "error",
      message: "worktree backend failed",
      workspace_id: workspace.workspace_id,
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("retains rejected worktree dispatches with retrievable cleanup IDs", async () => {
    const workspace = {
      workspace_id: "rejected-workspace",
      mode: "worktree",
      source_directory: process.cwd(),
      execution_directory: process.cwd(),
      managed: true,
      base_commit: "fixture-commit",
      source_dirty: false,
      state: "active",
    };
    const managerPath = "../../../src/modules/shared/workspace-manager.js";
    vi.doMock(managerPath, () => ({
      createManagedWorkspace: vi.fn().mockResolvedValue(workspace),
      acquireManagedWorkspaceDispatch: () => () => {},
      registerManagedWorkspaceSession: () => true,
      associateManagedWorkspaceTask: vi.fn(),
    }));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-rejected" } }),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.doMock("../../../src/modules/shared/prompt-dispatch.js", () => ({
      sendPromptAndClassify: vi
        .fn()
        .mockResolvedValue({ state: "rejected", status: 400, error: "prompt rejected" }),
    }));
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    registry.registerServer({
      serverId: "rejected-worktree-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const result = await fake.getHandler()({
      server_id: "rejected-worktree-server",
      prompt: "test",
      workspace_mode: "worktree",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      status: "prompt_rejected",
      task_id: expect.any(String),
      run_id: expect.any(String),
      workspace_id: workspace.workspace_id,
    });
    expect(tasks.getTask(payload.task_id)?.runs?.[0]).toMatchObject({
      reportReady: true,
      executionState: "failed",
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("@opencode-ai/sdk");
    vi.doUnmock("../../../src/modules/shared/prompt-dispatch.js");
    vi.doUnmock("../../../src/modules/shared/run-observer.js");
    vi.resetModules();
  });

  it("removes shared tasks after definite prompt rejection", async () => {
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "shared-rejected-session" } }),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.doMock("../../../src/modules/shared/prompt-dispatch.js", () => ({
      sendPromptAndClassify: vi
        .fn()
        .mockResolvedValue({ state: "rejected", status: 400, error: "no" }),
    }));
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    registry.registerServer({
      serverId: "shared-rejected-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const result = await fake.getHandler()({
      server_id: "shared-rejected-server",
      prompt: "reject me",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ status: "prompt_rejected", message: "no" });
    expect(payload.workspace.mode).toBe("shared");
    expect(tasks.getTask(payload.task_id)).toBeUndefined();
    vi.doUnmock("@opencode-ai/sdk");
    vi.doUnmock("../../../src/modules/shared/prompt-dispatch.js");
    vi.doUnmock("../../../src/modules/shared/run-observer.js");
    vi.resetModules();
  });

  it("keeps provisioned IDs reachable when project validation or session creation fails", async () => {
    const workspace = {
      workspace_id: "early-failure-workspace",
      mode: "worktree",
      source_directory: process.cwd(),
      execution_directory: process.cwd(),
      managed: true,
      base_commit: "fixture-commit",
      source_dirty: false,
      state: "active",
    };
    const managerPath = "../../../src/modules/shared/workspace-manager.js";
    const managerMock = () => ({
      createManagedWorkspace: vi.fn().mockResolvedValue(workspace),
      acquireManagedWorkspaceDispatch: () => () => {},
      sharedWorkspaceMetadata: () => workspace,
    });

    vi.doMock(managerPath, managerMock);
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        config: { providers: vi.fn().mockResolvedValue({ data: { providers: [] } }) },
        session: { create: vi.fn() },
      }),
    }));
    vi.resetModules();
    let mod = await import("../../../src/modules/tools/start_task.js");
    let registry = await import("../../../src/modules/shared/server-registry.js");
    registry.registerServer({
      serverId: "early-validation-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    let fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const unknown = await fake.getHandler()({
      server_id: "early-validation-server",
      prompt: "validate",
      workspace_mode: "worktree",
      model: "unknown/model",
    });
    expect(JSON.parse(unknown.content[0].text)).toMatchObject({
      status: "unknown_model",
      workspace_id: workspace.workspace_id,
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();

    vi.doMock(managerPath, managerMock);
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({ session: { create: vi.fn().mockResolvedValue({}) } }),
    }));
    vi.resetModules();
    mod = await import("../../../src/modules/tools/start_task.js");
    registry = await import("../../../src/modules/shared/server-registry.js");
    registry.registerServer({
      serverId: "early-session-server",
      baseUrl: "http://localhost",
      directory: process.cwd(),
      close: vi.fn(),
    });
    fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const missingSession = await fake.getHandler()({
      server_id: "early-session-server",
      prompt: "create",
      workspace_mode: "worktree",
    });
    expect(JSON.parse(missingSession.content[0].text)).toMatchObject({
      status: "error",
      workspace_id: workspace.workspace_id,
      workspace: { managed: true },
    });
    vi.doUnmock(managerPath);
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("returns unknown_model when the provider is not on the server", async () => {
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: { create: vi.fn(), promptAsync: vi.fn() },
        config: {
          providers: vi.fn().mockResolvedValue({
            data: { providers: [{ id: "opencode-go", models: { "minimax-m3": {} } }] },
          }),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({
      server_id: "srv-1",
      prompt: "hi",
      model: "opencode/minimax-m3",
    });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            status: "unknown_model",
            model: "opencode/minimax-m3",
            message:
              "model is not available on this server; copy an exact 'providerID/modelID' from opencode_list_agents (or from available_models below) instead of guessing",
            available_models: ["opencode-go/minimax-m3"],
          }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("returns unknown_model when the model is missing from a known provider", async () => {
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: { create: vi.fn(), promptAsync: vi.fn() },
        config: {
          providers: vi.fn().mockResolvedValue({
            data: { providers: [{ id: "opencode-go", models: { "minimax-m3": {} } }] },
          }),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi", model: "opencode-go/nope" });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse((result as { content: { text: string }[] }).content[0].text)).toMatchObject({
      status: "unknown_model",
      model: "opencode-go/nope",
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("skips model validation when the provider catalog is unavailable", async () => {
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync: vi.fn().mockResolvedValue({}),
        },
        config: {
          providers: vi.fn().mockResolvedValue({ error: { message: "boom" } }),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi", model: "any/model" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"status":"pending"') }],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("returns an error when session creation fails to yield an id", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({}),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server_id: "srv-1",
            status: "error",
            message: "failed to create session",
          }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("surfaces session creation errors and tracks ambiguous prompt response errors", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "HTTP create failed" } })
      .mockResolvedValueOnce({ data: { id: "session-1" } });
    const promptAsync = vi.fn().mockResolvedValue({ error: { message: "HTTP dispatch failed" } });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({ session: { create, promptAsync } }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({ serverId: "srv-1", baseUrl: "http://localhost", close: vi.fn() });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);

    const handler = fake.getHandler();
    const createResult = await handler({ server_id: "srv-1", prompt: "first" });
    const dispatchResult = await handler({ server_id: "srv-1", prompt: "second" });

    expect(createResult).toMatchObject({ isError: true });
    expect(
      JSON.parse((dispatchResult as { content: { text: string }[] }).content[0].text),
    ).toMatchObject({
      status: "dispatch_uncertain",
      dispatch: { state: "uncertain", error: "HTTP dispatch failed" },
    });
    expect(promptAsync).toHaveBeenCalledOnce();
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("creates a session, starts the prompt, and registers a task", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync: vi.fn().mockResolvedValue({}),
        },
        config: {
          providers: vi.fn().mockResolvedValue({
            data: {
              providers: [{ id: "anthropic", models: { "claude-sonnet-4": {} } }],
            },
          }),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({
      server_id: "srv-1",
      prompt: "do the thing",
      agent: "build",
      model: "anthropic/claude-sonnet-4",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "generated-task-id",
            run_id: "generated-task-id",
            server_id: "srv-1",
            session_id: "session-1",
            workspace: {
              mode: "shared",
              source_directory: process.cwd(),
              execution_directory: process.cwd(),
              managed: false,
              state: "active",
            },
            status: "pending",
          }),
        },
      ],
    });
    expect(tasks.getTask("generated-task-id")).toMatchObject({
      taskId: "generated-task-id",
      serverId: "srv-1",
      sessionId: "session-1",
      createdAt: expect.any(Number),
      currentRunId: "generated-task-id",
      runs: [
        {
          run_id: "generated-task-id",
          message_id: "msg_generated-task-id",
          startedAt: expect.any(Number),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("creates a session without optional agent or model fields", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    const promptAsync = vi.fn().mockResolvedValue({});
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync,
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    await handler({ server_id: "srv-1", prompt: "do the thing" });

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session-1" },
      body: { messageID: "msg_generated-task-id", parts: [{ type: "text", text: "do the thing" }] },
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("captures caller criteria and retains a start-time inventory failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "start-report-baseline-"));
    await writeFile(path.join(directory, "oversized.bin"), Buffer.alloc(32 * 1024 * 1024 + 1));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync: vi.fn().mockResolvedValue({}),
        },
      }),
    }));
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "report-server",
      baseUrl: "http://127.0.0.1:4096",
      directory,
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const result = await fake.getHandler()({
      server_id: "report-server",
      prompt: "verify baseline failure handling",
      expected_changes: [{ path: "made.txt", change: "created" }],
      checks: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: "." }],
    });
    const run = tasks.getTask("generated-task-id")?.runs?.[0];
    expect(JSON.parse(result.content[0].text).status).toBe("pending");
    expect(run?.message_id).toMatch(/^msg_/);
    expect(run?.expectedChanges).toEqual([{ path: "made.txt", change: "created" }]);
    expect(run?.checks).toHaveLength(1);
    expect(run?.baseline).toBeUndefined();
    expect(run?.baselineError).toContain("file inventory exceeded");
    tasks.removeTask("generated-task-id");
    registry.killAllServers();
    await rm(directory, { recursive: true, force: true });
    vi.doUnmock("@opencode-ai/sdk");
    vi.doUnmock("../../../src/modules/shared/run-observer.js");
    vi.resetModules();
  });

  it("returns workspace_busy when another verified MCP task owns an overlapping workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "start-workspace-busy-"));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync: vi.fn().mockResolvedValue({}),
        },
      }),
    }));
    vi.resetModules();
    const executionReport = await import("../../../src/modules/shared/execution-report.js");
    const blockingLease = await executionReport.reserveWorkspace(directory, true);
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "busy-server",
      baseUrl: "http://localhost",
      directory,
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const result = await fake.getHandler()({
      server_id: "busy-server",
      prompt: "must not dispatch",
      checks: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"] }],
    });
    expect(JSON.parse(result.content[0].text).status).toBe("workspace_busy");
    if (!blockingLease) throw new Error("expected a blocking workspace lease");
    executionReport.releaseWorkspace(blockingLease);
    registry.killAllServers();
    await rm(directory, { recursive: true, force: true });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("normalizes non-Error baseline failures and retains leases after an ambiguous dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "start-baseline-raw-"));
    const promptAsync = vi.fn().mockRejectedValue("dispatch string failure");
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync,
        },
      }),
    }));
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));
    vi.doMock("../../../src/modules/shared/execution-report.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../../src/modules/shared/execution-report.js")>()),
      captureWorkspace: vi.fn().mockRejectedValue("raw baseline failure"),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    registry.registerServer({
      serverId: "raw-server",
      baseUrl: "http://localhost",
      directory,
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();
    const uncertain = await handler({
      server_id: "raw-server",
      prompt: "keep report tracked",
      expected_changes: [{ path: "x.txt", change: "created" }],
    });
    const payload = JSON.parse(uncertain.content[0].text);
    expect(payload.status).toBe("dispatch_uncertain");
    expect(tasks.getTask(payload.task_id)?.runs?.[0]).toMatchObject({
      dispatchState: "uncertain",
      dispatchError: "dispatch string failure",
      baselineError: "raw baseline failure",
    });
    const executionReport = await import("../../../src/modules/shared/execution-report.js");
    expect(await executionReport.reserveWorkspace(directory, true)).toBeUndefined();
    tasks.removeTask("generated-task-id");
    const nextLease = await executionReport.reserveWorkspace(directory, true);
    expect(nextLease).toBeDefined();
    if (!nextLease) throw new Error("expected workspace lease after task cleanup");
    executionReport.releaseWorkspace(nextLease);
    registry.killAllServers();
    await rm(directory, { recursive: true, force: true });
    vi.doUnmock("@opencode-ai/sdk");
    vi.doUnmock("../../../src/modules/shared/run-observer.js");
    vi.doUnmock("../../../src/modules/shared/execution-report.js");
    vi.resetModules();
  });

  it("rolls back a provisional workspace lease when run metadata cannot be allocated", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "start-provisional-rollback-"));
    vi.doMock("node:crypto", () => ({
      randomUUID: () => {
        throw new Error("uuid unavailable");
      },
    }));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
          promptAsync: vi.fn().mockResolvedValue({}),
        },
      }),
    }));
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const executionReport = await import("../../../src/modules/shared/execution-report.js");
    registry.registerServer({
      serverId: "rollback-server",
      baseUrl: "http://localhost",
      directory,
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const result = await fake.getHandler()({ server_id: "rollback-server", prompt: "rollback" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "error",
      message: "uuid unavailable",
    });
    const lease = await executionReport.reserveWorkspace(directory, true);
    expect(lease).toBeDefined();
    if (!lease) throw new Error("expected workspace lease after rollback");
    executionReport.releaseWorkspace(lease);
    registry.killAllServers();
    await rm(directory, { recursive: true, force: true });
    vi.doUnmock("node:crypto");
    vi.doUnmock("@opencode-ai/sdk");
    vi.doUnmock("../../../src/modules/shared/run-observer.js");
    vi.resetModules();
  });

  it("returns an error result when the SDK throws an Error", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockRejectedValue(new Error("db down")),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "db down" }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("returns an error result when the SDK throws a non-Error value", async () => {
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        session: {
          create: vi.fn().mockRejectedValue("weird"),
          promptAsync: vi.fn(),
        },
      }),
    }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    registry.killAllServers();
    registry.registerServer({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1", prompt: "hi" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ server_id: "srv-1", status: "error", message: "weird" }),
        },
      ],
    });
    vi.doUnmock("@opencode-ai/sdk");
    vi.resetModules();
  });

  it("starts a task in a detached committed worktree and leaves the dirty source untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "start-worktree-integration-"));
    const serverRoot = path.join(root, "server");
    const repository = path.join(serverRoot, "project");
    const source = path.join(repository, "packages", "app");
    const cache = path.join(root, "cache");
    await mkdir(source, { recursive: true });
    execFileSync("git", ["init", "-q", repository]);
    await writeFile(path.join(source, "shared.txt"), "committed\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ]);
    await writeFile(path.join(source, "shared.txt"), "source dirty\n");
    await writeFile(path.join(source, "untracked.txt"), "source untracked\n");
    const previousCache = process.env.OPENCODE_MCP_WORKSPACE_DIR;
    process.env.OPENCODE_MCP_WORKSPACE_DIR = cache;
    let generated = 0;
    vi.doMock("node:crypto", () => ({ randomUUID: () => `worktree-id-${++generated}` }));
    const promptAsync = vi.fn().mockResolvedValue({});
    const scopedClientOptions: unknown[] = [];
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: (options: unknown) => {
        scopedClientOptions.push(options);
        return {
          session: {
            create: vi.fn().mockResolvedValue({ data: { id: "worktree-session" } }),
            promptAsync,
          },
          config: {
            providers: vi.fn().mockResolvedValue({
              data: { providers: [{ id: "fixture", models: { model: {} } }] },
            }),
          },
        };
      },
    }));
    vi.doMock("../../../src/modules/shared/run-observer.js", () => ({ observeRun: vi.fn() }));
    vi.resetModules();
    const mod = await import("../../../src/modules/tools/start_task.js");
    const registry = await import("../../../src/modules/shared/server-registry.js");
    const tasks = await import("../../../src/modules/shared/task-registry.js");
    const reports = await import("../../../src/modules/shared/execution-report.js");
    const cleanupModule = await import("../../../src/modules/tools/cleanup_workspace.js");
    registry.registerServer({
      serverId: "worktree-server",
      baseUrl: "http://localhost",
      directory: serverRoot,
      close: vi.fn(),
    });
    const fake = createFakeMcpServer();
    mod.registerOpencodeStartTask(fake.server);

    try {
      const started = await fake.getHandler()({
        server_id: "worktree-server",
        directory: "project/packages/app",
        workspace_mode: "worktree",
        prompt: "perform isolated work",
        model: "fixture/model",
      });
      const data = JSON.parse(started.content[0].text);
      expect(data.workspace).toMatchObject({
        mode: "worktree",
        managed: true,
        source_directory: await realpath(source),
        base_commit: expect.any(String),
        source_dirty: true,
      });
      expect(data.workspace.execution_directory).toContain("packages/app");
      expect(scopedClientOptions[0]).toMatchObject({
        directory: data.workspace.execution_directory,
      });
      expect(await readFile(path.join(source, "shared.txt"), "utf8")).toBe("source dirty\n");
      expect(await readFile(path.join(source, "untracked.txt"), "utf8")).toBe("source untracked\n");
      expect(
        await readFile(path.join(data.workspace.execution_directory, "shared.txt"), "utf8"),
      ).toBe("committed\n");
      expect(promptAsync).toHaveBeenCalledOnce();

      const task = tasks.getTask(data.task_id);
      if (!task) throw new Error("managed worktree task was not registered");
      const firstRun = task.runs?.[0];
      if (!firstRun) throw new Error("initial managed task run was not registered");
      if (firstRun.workspaceLease) reports.releaseWorkspace(firstRun.workspaceLease);
      firstRun.workspaceLease = undefined;
      firstRun.reportReady = true;
      firstRun.executionState = "completed";
      firstRun.usage = {
        captured_at: "2026-10-07T00:00:00.000Z",
        snapshot_kind: "run_finalization",
        report: null,
      };
      firstRun.result = {
        task_id: task.taskId,
        run_id: firstRun.run_id,
        status: "completed",
        result: "cached first run",
        usage: firstRun.usage,
      };
      const continueModule = await import("../../../src/modules/tools/continue_task.js");
      const continuationServer = createFakeMcpServer();
      continueModule.registerOpencodeContinueTask(continuationServer.server);
      const continuation = await continuationServer.getHandler()({
        task_id: task.taskId,
        prompt: "continue in this workspace",
      });
      const continued = JSON.parse(continuation.content[0].text);
      expect(continued.workspace).toEqual(data.workspace);
      const secondRun = task.runs?.[1];
      if (!secondRun) throw new Error("continuation run was not registered");
      if (secondRun.workspaceLease) reports.releaseWorkspace(secondRun.workspaceLease);
      secondRun.workspaceLease = undefined;
      secondRun.reportReady = true;
      secondRun.executionState = "completed";
      secondRun.result = {
        task_id: task.taskId,
        run_id: secondRun.run_id,
        status: "completed",
        result: "cached second run",
      };
      const cleanup = createFakeMcpServer();
      cleanupModule.registerOpencodeCleanupWorkspace(cleanup.server);
      const removed = await cleanup.getHandler()({ workspace_id: data.workspace_id });
      expect(JSON.parse(removed.content[0].text).status).toBe("removed");
      const afterRemoval = await continuationServer.getHandler()({
        task_id: task.taskId,
        prompt: "must not run",
      });
      expect(JSON.parse(afterRemoval.content[0].text).status).toBe("workspace_removed");
      registry.removeServer("worktree-server");

      const resultModule = await import("../../../src/modules/tools/get_task_result.js");
      const getter = createFakeMcpServer();
      resultModule.registerOpencodeGetTaskResult(getter.server);
      const cached = await getter.getHandler()({ task_id: task.taskId, run_id: firstRun.run_id });
      expect(JSON.parse(cached.content[0].text)).toMatchObject({
        result: "cached first run",
        usage: { snapshot_kind: "run_finalization" },
        workspace: { state: "removed", workspace_id: data.workspace_id },
      });
      const statusModule = await import("../../../src/modules/tools/get_task_status.js");
      const statusServer = createFakeMcpServer();
      statusModule.registerOpencodeGetTaskStatus(statusServer.server);
      const cachedStatus = await statusServer.getHandler()({ task_id: task.taskId });
      expect(JSON.parse(cachedStatus.content[0].text).workspace.state).toBe("removed");
      const waitModule = await import("../../../src/modules/tools/wait_for_task.js");
      const waitServer = createFakeMcpServer();
      waitModule.registerOpencodeWaitForTask(waitServer.server);
      const waited = await waitServer.getHandler()({ task_ids: [task.taskId], until: "report" });
      expect(JSON.parse(waited.content[0].text).tasks[0].workspace.state).toBe("removed");
    } finally {
      registry.killAllServers();
      await rm(root, { recursive: true, force: true });
      if (previousCache === undefined) delete process.env.OPENCODE_MCP_WORKSPACE_DIR;
      else process.env.OPENCODE_MCP_WORKSPACE_DIR = previousCache;
      vi.doUnmock("@opencode-ai/sdk");
      vi.doUnmock("node:crypto");
      vi.doUnmock("../../../src/modules/shared/run-observer.js");
      vi.resetModules();
    }
  });
});

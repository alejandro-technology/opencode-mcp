import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRawDb, resetDbForTests } from "../../../src/modules/shared/db/index.js";
import { registerServer, removeServer } from "../../../src/modules/shared/server-registry.js";
import {
  acquireManagedWorkspaceDispatch,
  associateManagedWorkspaceTask,
  createManagedWorkspace,
  hydrateWorkspaceRecord,
  managedWorkspaceTaskIds,
  registerManagedWorkspaceSession,
  releaseManagedWorkspaceCleanup,
  removeManagedWorkspace,
  reserveManagedWorkspaceCleanup,
  resetWorkspaceManagerForTests,
  sharedWorkspaceMetadata,
  workspaceMetadata,
} from "../../../src/modules/shared/workspace-manager.js";

const roots: string[] = [];

function workspaceID(metadata: { workspace_id?: string }): string {
  if (!metadata.workspace_id) throw new Error("managed workspace id was not returned");
  return metadata.workspace_id;
}

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-manager-test-"));
  roots.push(root);
  const repository = join(root, "repo");
  const source = join(repository, "packages", "app");
  await mkdir(source, { recursive: true });
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(source, "tracked.txt"), "base\n");
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
  registerServer({
    serverId: root,
    baseUrl: "http://127.0.0.1:4096",
    directory: root,
    close: () => {},
  });
  return { root, source };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    removeServer(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("managed workspace lifecycle", () => {
  it("tracks provisioned ownership, task sessions, dispatch leases, and removal state", async () => {
    const { root, source } = await gitFixture();
    const metadata = await createManagedWorkspace(root, source);
    const workspaceId = workspaceID(metadata);
    expect(metadata).toMatchObject({
      mode: "worktree",
      managed: true,
      state: "active",
      source_dirty: false,
    });
    expect(workspaceMetadata(workspaceId)).toEqual(metadata);
    removeServer(root);
    expect(registerManagedWorkspaceSession(workspaceId, "no-server-session")).toBe(false);
    registerServer({
      serverId: root,
      baseUrl: "http://127.0.0.1:4096",
      directory: root,
      close: () => {},
    });
    expect(registerManagedWorkspaceSession(workspaceId, "session-1")).toBe(true);
    expect(associateManagedWorkspaceTask(workspaceId, "task-1")).toBe(true);
    expect(managedWorkspaceTaskIds(workspaceId)).toEqual(["task-1"]);

    const release = acquireManagedWorkspaceDispatch(workspaceId);
    expect(release).toBeTypeOf("function");
    expect(reserveManagedWorkspaceCleanup(workspaceId)).toBeUndefined();
    release?.();
    release?.();

    const cleanup = reserveManagedWorkspaceCleanup(workspaceId);
    expect(cleanup?.taskIds).toEqual(["task-1"]);
    expect(acquireManagedWorkspaceDispatch(workspaceId)).toBeUndefined();
    releaseManagedWorkspaceCleanup(workspaceId);
    const retryDispatch = acquireManagedWorkspaceDispatch(workspaceId);
    expect(retryDispatch).toBeTypeOf("function");
    retryDispatch?.();
    const secondCleanup = reserveManagedWorkspaceCleanup(workspaceId);
    expect(secondCleanup).toBeDefined();
    await removeManagedWorkspace(workspaceId, false);
    expect(workspaceMetadata(workspaceId)?.state).toBe("removed");
    expect(managedWorkspaceTaskIds(workspaceId)).toEqual(["task-1"]);
    expect(reserveManagedWorkspaceCleanup(workspaceId)).toBeUndefined();
  });

  it("keeps shared metadata unmanaged and rejects foreign or removed workspace leases", async () => {
    const { root, source } = await gitFixture();
    expect(sharedWorkspaceMetadata(source)).toEqual({
      mode: "shared",
      source_directory: source,
      execution_directory: source,
      managed: false,
      state: "active",
    });
    expect(workspaceMetadata("foreign-workspace")).toBeUndefined();
    expect(managedWorkspaceTaskIds("foreign-workspace")).toEqual([]);
    expect(registerManagedWorkspaceSession("foreign-workspace", "foreign-session")).toBe(false);
    expect(associateManagedWorkspaceTask("foreign-workspace", "foreign-task")).toBe(false);
    const untracked = acquireManagedWorkspaceDispatch(undefined);
    expect(untracked).toBeTypeOf("function");
    untracked?.();
    expect(acquireManagedWorkspaceDispatch("foreign-workspace")).toBeUndefined();
    expect(reserveManagedWorkspaceCleanup("foreign-workspace")).toBeUndefined();
    await expect(removeManagedWorkspace("foreign-workspace", true)).rejects.toThrow(
      "workspace cleanup lease is not held",
    );

    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    await expect(removeManagedWorkspace(id, true)).rejects.toThrow(
      "workspace cleanup lease is not held",
    );
    const cleanup = reserveManagedWorkspaceCleanup(id);
    expect(cleanup).toBeDefined();
    await removeManagedWorkspace(id, true);
    expect(acquireManagedWorkspaceDispatch(id)).toBeUndefined();
    releaseManagedWorkspaceCleanup(id);
    expect(reserveManagedWorkspaceCleanup(id)).toBeUndefined();
  });

  it("records dirty source state without copying it into the committed worktree", async () => {
    const { root, source } = await gitFixture();
    await writeFile(join(source, "tracked.txt"), "source-only\n");
    const metadata = await createManagedWorkspace(root, source);
    expect(metadata.source_dirty).toBe(true);
    expect(await readFile(join(metadata.execution_directory, "tracked.txt"), "utf8")).toBe(
      "base\n",
    );
    const id = workspaceID(metadata);
    const cleanup = reserveManagedWorkspaceCleanup(id);
    if (!cleanup) throw new Error("workspace cleanup reservation failed");
    await removeManagedWorkspace(id, true);
    expect(cleanup.handle.sourceDirectory).toBe(await realpath(source));
  });
});

describe("cross-restart workspace re-hydration", () => {
  it("re-hydrates metadata from SQLite after clearing maps", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    resetDbForTests();
    resetWorkspaceManagerForTests();
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    getRawDb();
    expect(workspaceMetadata(id)?.state).toBe("active");
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });

  it("re-hydrates and reserves cleanup after clearing maps", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    resetDbForTests();
    resetWorkspaceManagerForTests();
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    getRawDb();
    const cleanup = reserveManagedWorkspaceCleanup(id);
    expect(cleanup).toBeDefined();
    releaseManagedWorkspaceCleanup(id);
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });
});

describe("workspace manager uncovered branches", () => {
  it("returns undefined when hydration cannot open the database", () => {
    const dbDir = join(tmpdir(), `wm-dbdir-${Date.now()}`);
    mkdirSync(dbDir, { recursive: true });
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbDir;
    resetDbForTests();
    expect(workspaceMetadata("any")).toBeUndefined();
    resetDbForTests();
    rmSync(dbDir, { recursive: true, force: true });
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });

  it("returns undefined when reserve cannot open the database", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    resetDbForTests();
    const dbDir = join(root, "db-as-dir");
    await mkdir(dbDir, { recursive: true });
    process.env.OPENCODE_MCP_HISTORY_DB = dbDir;
    expect(reserveManagedWorkspaceCleanup(id)).toBeUndefined();
    resetDbForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });

  it("handles a missing tasks table during hydration", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    getRawDb().exec("DROP TABLE tasks");
    resetDbForTests();
    resetWorkspaceManagerForTests();
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    getRawDb();
    expect(workspaceMetadata(id)?.state).toBe("active");
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });
});

describe("workspace manager task id hydration", () => {
  it("hydrates task ids from the tasks table", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    const now = Date.now();
    getRawDb()
      .prepare(
        "INSERT INTO tasks (task_id, server_id, session_id, workspace_id, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("task-x", root, "session-x", id, now, now);
    resetDbForTests();
    resetWorkspaceManagerForTests();
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    getRawDb();
    expect(managedWorkspaceTaskIds(id)).toContain("task-x");
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });
});

describe("workspace manager branch coverage", () => {
  it("covers hydrate existing-record branch", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    // hydrate once, then again to hit existing branch
    const first = hydrateWorkspaceRecord(id);
    const second = hydrateWorkspaceRecord(id);
    expect(second).toBe(first);
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });

  it("covers reserve zero-rows branch", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    // mark DB row non-active while in-memory stays active
    getRawDb().prepare("UPDATE workspaces SET state='cleaning' WHERE workspace_id=?").run(id);
    expect(reserveManagedWorkspaceCleanup(id)).toBeUndefined();
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });

  it("covers release hydration branches", async () => {
    const { root, source } = await gitFixture();
    const dbFile = join(root, "history.sqlite");
    const previousDb = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbFile;
    resetDbForTests();
    const metadata = await createManagedWorkspace(root, source);
    const id = workspaceID(metadata);
    // existing record branch
    releaseManagedWorkspaceCleanup(id);
    // missing record branch (clear map)
    resetWorkspaceManagerForTests();
    releaseManagedWorkspaceCleanup(id);
    resetDbForTests();
    resetWorkspaceManagerForTests();
    if (previousDb === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previousDb;
  });
});

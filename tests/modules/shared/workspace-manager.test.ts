import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerServer, removeServer } from "../../../src/modules/shared/server-registry.js";
import {
  acquireManagedWorkspaceDispatch,
  associateManagedWorkspaceTask,
  createManagedWorkspace,
  managedWorkspaceTaskIds,
  registerManagedWorkspaceSession,
  releaseManagedWorkspaceCleanup,
  removeManagedWorkspace,
  reserveManagedWorkspaceCleanup,
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

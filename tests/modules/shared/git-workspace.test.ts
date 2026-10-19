import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitWorkspace,
  describeGitWorkspace,
  type GitRunner,
  GitWorkspaceError,
  removeGitWorkspace,
} from "../../../src/modules/shared/git-workspace.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; source: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), "git-workspace-test-"));
  roots.push(root);
  const repository = join(root, "repo");
  const source = join(repository, "packages", "app");
  const cache = join(root, "cache");
  await mkdir(source, { recursive: true });
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(source, "same.txt"), "committed\n");
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
  return { root, source, cache };
}

const realGit: GitRunner = async (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Git workspaces", () => {
  it("creates detached isolated worktrees preserving nested execution path and source dirt", async () => {
    const { source, cache } = await fixture();
    await writeFile(join(source, "same.txt"), "local edit\n");
    await writeFile(join(source, "untracked.txt"), "keep\n");
    const workspace = await createGitWorkspace(source, { workspaceParent: cache });
    expect(workspace.sourceDirty).toBe(true);
    expect(workspace.executionDirectory).toBe(join(workspace.worktreeDirectory, "packages", "app"));
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("local edit\n");
    expect(await readFile(join(source, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(workspace.executionDirectory, "same.txt"), "utf8")).toBe(
      "committed\n",
    );
    expect(describeGitWorkspace(workspace)).toEqual(workspace);
    await writeFile(join(workspace.executionDirectory, "same.txt"), "workspace edit\n");
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("local edit\n");
    await expect(removeGitWorkspace(workspace)).rejects.toMatchObject({ code: "dirty" });
    await removeGitWorkspace(workspace, { discardChanges: true });
  });

  it("removes clean worktrees and refuses forged handles", async () => {
    const { source, cache } = await fixture();
    const workspace = await createGitWorkspace(source, { workspaceParent: cache });
    expect(() => describeGitWorkspace({ ...workspace })).toThrow(GitWorkspaceError);
    await expect(removeGitWorkspace({ ...workspace })).rejects.toMatchObject({ code: "not_owned" });
    await removeGitWorkspace(workspace);
    expect(() => describeGitWorkspace(workspace)).toThrow(/not owned/i);
  });

  it("rejects missing/non-repository sources and option-like invalid refs", async () => {
    const { root, source, cache } = await fixture();
    await expect(
      createGitWorkspace(join(root, "missing"), { workspaceParent: cache }),
    ).rejects.toMatchObject({ code: "not_repository" });
    await expect(createGitWorkspace(root, { workspaceParent: cache })).rejects.toMatchObject({
      code: "not_repository",
    });
    await expect(
      createGitWorkspace(source, { workspaceParent: cache, baseRef: "--upload-pack=bad" }),
    ).rejects.toMatchObject({ code: "invalid_base_ref" });
  });

  it("accepts canonical source aliases and rejects a selected base missing the nested package", async () => {
    const { root, source, cache } = await fixture();
    const alias = join(root, "source-alias");
    await symlink(source, alias);
    const workspace = await createGitWorkspace(alias, { workspaceParent: cache });
    expect(workspace.sourceDirectory).toBe(await realpath(source));
    await removeGitWorkspace(workspace);

    const repository = join(root, "repo");
    const emptyTree = execFileSync("git", ["-C", repository, "mktree"], {
      input: "",
      encoding: "utf8",
    }).trim();
    const base = execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit-tree",
        emptyTree,
        "-m",
        "empty tree",
      ],
      { encoding: "utf8" },
    ).trim();
    await expect(
      createGitWorkspace(source, { workspaceParent: cache, baseRef: base }),
    ).rejects.toMatchObject({ code: "missing_execution_directory" });
  });

  it("reports Git executable and bounded command failures as typed errors", async () => {
    const { source, cache } = await fixture();
    await expect(
      createGitWorkspace(source, {
        workspaceParent: cache,
        gitExecutable: join(cache, "missing-git"),
      }),
    ).rejects.toMatchObject({ code: "git_unavailable" });
    const unavailable: GitRunner = async () => {
      throw new GitWorkspaceError("git_unavailable", "Git executable is unavailable");
    };
    await expect(
      createGitWorkspace(source, { workspaceParent: cache, gitRunner: unavailable }),
    ).rejects.toMatchObject({ code: "git_unavailable" });

    const invalidCommand: GitRunner = async () => {
      throw Object.assign(new Error("deadline"), { killed: true });
    };
    await expect(
      createGitWorkspace(source, { workspaceParent: cache, gitRunner: invalidCommand }),
    ).rejects.toMatchObject({ code: "not_repository" });
    const invalidRefRunner: GitRunner = async (cwd, args) => {
      if (args.includes("--verify")) throw new Error("invalid ref");
      return realGit(cwd, args);
    };
    await expect(
      createGitWorkspace(source, {
        workspaceParent: cache,
        baseRef: "bad",
        gitRunner: invalidRefRunner,
      }),
    ).rejects.toMatchObject({ code: "invalid_base_ref" });
  });

  it("does not remove a partial worktree after a provisioning command failure", async () => {
    const { source, cache } = await fixture();
    const failAfterAdd: GitRunner = async (cwd, args) => {
      const result = await realGit(cwd, args);
      if (args.includes("add")) throw new Error("simulated lost command response");
      return result;
    };
    await expect(
      createGitWorkspace(source, { workspaceParent: cache, gitRunner: failAfterAdd }),
    ).rejects.toMatchObject({ code: "provision_failed" });
    expect((await readdir(cache)).length).toBe(1);
  });

  it("reports cache preparation failures and refuses any handle that aliases the source", async () => {
    const { source, root, cache } = await fixture();
    const blockedParent = join(root, "ordinary-file");
    await writeFile(blockedParent, "not a directory");
    await expect(
      createGitWorkspace(source, { workspaceParent: blockedParent }),
    ).rejects.toMatchObject({ code: "provision_failed" });
    const workspace = await createGitWorkspace(source, { workspaceParent: cache });
    const original = workspace.worktreeDirectory;
    workspace.worktreeDirectory = workspace.sourceDirectory;
    await expect(removeGitWorkspace(workspace)).rejects.toMatchObject({ code: "tampered" });
    workspace.worktreeDirectory = original;
    await removeGitWorkspace(workspace);
  });

  it("refuses missing, renamed, and symlinked workspace roots without deleting targets", async () => {
    const { root, source, cache } = await fixture();
    const missing = await createGitWorkspace(source, { workspaceParent: cache });
    await rm(missing.worktreeDirectory, { recursive: true });
    await expect(removeGitWorkspace(missing)).rejects.toMatchObject({ code: "tampered" });

    const renamed = await createGitWorkspace(source, { workspaceParent: cache });
    const moved = `${renamed.worktreeDirectory}-moved`;
    await rename(renamed.worktreeDirectory, moved);
    await expect(removeGitWorkspace(renamed)).rejects.toMatchObject({ code: "tampered" });
    await rename(moved, renamed.worktreeDirectory);
    await removeGitWorkspace(renamed);

    const symlinked = await createGitWorkspace(source, { workspaceParent: cache });
    const outside = join(root, "outside");
    await mkdir(outside);
    await rm(symlinked.worktreeDirectory, { recursive: true });
    await symlink(outside, symlinked.worktreeDirectory);
    await expect(removeGitWorkspace(symlinked)).rejects.toMatchObject({ code: "tampered" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("uses configured cache roots and keeps source paths protected during cleanup", async () => {
    const { source, root } = await fixture();
    const previous = process.env.OPENCODE_MCP_WORKSPACE_DIR;
    const selected = join(root, "selected-cache");
    process.env.OPENCODE_MCP_WORKSPACE_DIR = selected;
    try {
      const workspace = await createGitWorkspace(source);
      expect(workspace.worktreeDirectory.startsWith(await realpath(selected))).toBe(true);
      await removeGitWorkspace(workspace);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MCP_WORKSPACE_DIR;
      else process.env.OPENCODE_MCP_WORKSPACE_DIR = previous;
    }
    expect(await readFile(join(source, "same.txt"), "utf8")).toBe("committed\n");
  });

  it("falls back from XDG cache to the home cache directory", async () => {
    const { source, root } = await fixture();
    const previousWorkspace = process.env.OPENCODE_MCP_WORKSPACE_DIR;
    const previousXdg = process.env.XDG_CACHE_HOME;
    const xdg = join(root, "xdg");
    delete process.env.OPENCODE_MCP_WORKSPACE_DIR;
    process.env.XDG_CACHE_HOME = xdg;
    try {
      const xdgWorkspace = await createGitWorkspace(source);
      expect(
        xdgWorkspace.worktreeDirectory.startsWith(
          await realpath(join(xdg, "opencode-mcp", "workspaces")),
        ),
      ).toBe(true);
      await removeGitWorkspace(xdgWorkspace);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousXdg;
    }
    try {
      const homeWorkspace = await createGitWorkspace(source);
      expect(
        homeWorkspace.worktreeDirectory.startsWith(
          await realpath(join(homedir(), ".cache", "opencode-mcp", "workspaces")),
        ),
      ).toBe(true);
      await removeGitWorkspace(homeWorkspace);
    } finally {
      if (previousWorkspace === undefined) delete process.env.OPENCODE_MCP_WORKSPACE_DIR;
      else process.env.OPENCODE_MCP_WORKSPACE_DIR = previousWorkspace;
      if (previousXdg !== undefined) process.env.XDG_CACHE_HOME = previousXdg;
    }
  });

  it("detects mismatched common Git metadata and wraps removal command errors", async () => {
    const { source, cache } = await fixture();
    const other = await fixture();
    const seen: string[] = [];
    const mismatched: GitRunner = async (cwd, args) => {
      if (args.includes("--git-common-dir") && seen.length === 0) {
        seen.push(cwd);
        return join(await realpath(join(other.root, "repo")), ".git");
      }
      if (args.includes("--git-common-dir")) seen.push(cwd);
      return realGit(cwd, args);
    };
    const workspace = await createGitWorkspace(source, {
      workspaceParent: cache,
      gitRunner: mismatched,
    });
    await expect(removeGitWorkspace(workspace)).rejects.toMatchObject({ code: "tampered" });
    expect(seen[0]).toBe(workspace.worktreeDirectory);

    let rejectRemoval = true;
    const failRemoval: GitRunner = async (cwd, args) => {
      if (rejectRemoval && args.includes("remove")) throw new Error("remove failed");
      return realGit(cwd, args);
    };
    const second = await createGitWorkspace(source, {
      workspaceParent: cache,
      gitRunner: failRemoval,
    });
    await expect(removeGitWorkspace(second)).rejects.toMatchObject({ code: "remove_failed" });
    rejectRemoval = false;
    await removeGitWorkspace(second);
  });

  it("keeps independently created worktrees isolated", async () => {
    const { source, cache } = await fixture();
    const first = await createGitWorkspace(source, { workspaceParent: cache });
    const second = await createGitWorkspace(source, { workspaceParent: cache });
    await writeFile(join(first.executionDirectory, "same.txt"), "first\n");
    expect(await readFile(join(second.executionDirectory, "same.txt"), "utf8")).toBe("committed\n");
    await removeGitWorkspace(first, { discardChanges: true });
    await removeGitWorkspace(second);
  });
});

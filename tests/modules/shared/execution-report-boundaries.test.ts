import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  realpath: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, ...fs };
});

const { captureReport, captureWorkspace } = await import(
  "../../../src/modules/shared/execution-report.js"
);

beforeEach(() => {
  fs.realpath.mockReset().mockImplementation(async (value: string) => value);
  fs.lstat.mockReset().mockResolvedValue({
    isDirectory: () => false,
    isSymbolicLink: () => false,
    size: 0,
  });
  fs.readFile.mockReset().mockResolvedValue(Buffer.from("x"));
  fs.readlink.mockReset().mockResolvedValue("target");
  fs.readdir.mockReset().mockResolvedValue([]);
});

describe("workspace inventory hard bounds", () => {
  it("rejects inventories exceeding the file-count budget", async () => {
    fs.readdir.mockResolvedValueOnce(
      Array.from({ length: 20_001 }, (_, index) => ({
        name: `file-${index}`,
        isDirectory: () => false,
      })),
    );
    await expect(captureWorkspace("/workspace")).rejects.toThrow(
      "file inventory exceeded 20000 entries",
    );
  });

  it("rejects symlink inventories exceeding the aggregate byte budget", async () => {
    fs.readdir.mockResolvedValueOnce(
      Array.from({ length: 17_000 }, (_, index) => ({
        name: `link-${index}`,
        isDirectory: () => false,
      })),
    );
    fs.lstat.mockResolvedValue({
      isDirectory: () => false,
      isSymbolicLink: () => true,
      size: 0,
    });
    fs.readlink.mockResolvedValue("x".repeat(2_048));
    await expect(captureWorkspace("/workspace")).rejects.toThrow(
      "file inventory exceeded 33554432 bytes",
    );
  });

  it("reports non-Error post-capture failures as unavailable evidence", async () => {
    const before = { root: "/workspace", files: new Map<string, string>() };
    fs.realpath.mockRejectedValueOnce("raw filesystem failure");
    const report = await captureReport(
      before,
      [{ path: "created.txt", change: "created" }],
      [],
      "completed",
    );
    expect(report.verification.state).toBe("unavailable");
    expect(report.evidence.errors).toEqual(["raw filesystem failure"]);
  });
});

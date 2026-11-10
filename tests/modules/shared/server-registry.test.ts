import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "../../../src/modules/shared/db/index.js";
import { servers as serversTable } from "../../../src/modules/shared/db/schema.js";
import {
  getServer,
  killAllServers,
  type OpencodeServerInstance,
  registerServer,
  removeServer,
} from "../../../src/modules/shared/server-registry.js";

function makeInstance(overrides: Partial<OpencodeServerInstance> = {}): OpencodeServerInstance {
  return {
    serverId: "srv-1",
    baseUrl: "http://127.0.0.1:4096",
    close: vi.fn(),
    ...overrides,
  };
}

describe("server-registry", () => {
  beforeEach(() => {
    resetDbForTests();
    killAllServers();
  });

  afterEach(() => {
    resetDbForTests();
  });

  it("registers and retrieves a server", () => {
    const instance = makeInstance();
    registerServer(instance);
    expect(getServer("srv-1")).toBe(instance);
  });

  it("returns undefined for an unknown server id", () => {
    expect(getServer("missing")).toBeUndefined();
  });

  it("removes a registered server", () => {
    const instance = makeInstance();
    registerServer(instance);
    removeServer("srv-1");
    expect(getServer("srv-1")).toBeUndefined();
  });

  it("closes and clears all servers on killAllServers", () => {
    const a = makeInstance({ serverId: "a" });
    const b = makeInstance({ serverId: "b" });
    registerServer(a);
    registerServer(b);

    killAllServers();

    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(getServer("a")).toBeUndefined();
    expect(getServer("b")).toBeUndefined();
  });

  it("persists a server row on registerServer", () => {
    const instance = makeInstance({ directory: "/tmp/work", permissionPolicy: "allow" });
    registerServer(instance);

    const rows = getDb().select().from(serversTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serverId: "srv-1",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/tmp/work",
      permissionPolicy: "allow",
      ownerInstanceId: expect.any(String),
      stoppedAt: null,
    });
  });

  it("sets stopped_at on removeServer", () => {
    const instance = makeInstance();
    registerServer(instance);
    removeServer("srv-1");

    const row = getDb().select().from(serversTable).all()[0];
    expect(row.stoppedAt).not.toBeNull();
  });

  it("does not overwrite stopped_at when removeServer is called twice", () => {
    const instance = makeInstance();
    registerServer(instance);
    removeServer("srv-1");
    const first = getDb().select().from(serversTable).all()[0].stoppedAt;
    removeServer("srv-1");
    const second = getDb().select().from(serversTable).all()[0].stoppedAt;
    expect(second).toBe(first);
  });

  it("sets stopped_at for all servers on killAllServers", () => {
    const a = makeInstance({ serverId: "a" });
    const b = makeInstance({ serverId: "b" });
    registerServer(a);
    registerServer(b);

    killAllServers();

    const rows = getDb().select().from(serversTable).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.stoppedAt).not.toBeNull();
  });

  it("keeps registration working when the database write throws", () => {
    resetDbForTests();
    const previous = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = "/dev/null/impossible";
    const instance = makeInstance({ serverId: "throw-reg" });
    registerServer(instance);
    expect(getServer("throw-reg")).toBe(instance);
    if (previous === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previous;
    resetDbForTests();
  });

  it("keeps removal working when the database write throws", () => {
    const instance = makeInstance({ serverId: "throw-rem" });
    registerServer(instance);
    resetDbForTests();
    const previous = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = "/dev/null/impossible";
    removeServer("throw-rem");
    expect(getServer("throw-rem")).toBeUndefined();
    if (previous === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previous;
    resetDbForTests();
  });

  it("keeps killAllServers working when a database write throws", () => {
    const instance = makeInstance({ serverId: "throw-kill" });
    registerServer(instance);
    resetDbForTests();
    const previous = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = "/dev/null/impossible";
    killAllServers();
    expect(getServer("throw-kill")).toBeUndefined();
    if (previous === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previous;
    resetDbForTests();
  });

  it("survives resetDbForTests and reopen: stopped server remains listed as stopped", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "srv-reg-"));
    const dbPath = path.join(dir, "history.sqlite");
    const previous = process.env.OPENCODE_MCP_HISTORY_DB;
    process.env.OPENCODE_MCP_HISTORY_DB = dbPath;
    resetDbForTests();

    const instance = makeInstance({ serverId: "persisted" });
    registerServer(instance);
    removeServer("persisted");

    resetDbForTests();
    const rows = getDb().select().from(serversTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].serverId).toBe("persisted");
    expect(rows[0].stoppedAt).not.toBeNull();

    resetDbForTests();
    if (previous === undefined) delete process.env.OPENCODE_MCP_HISTORY_DB;
    else process.env.OPENCODE_MCP_HISTORY_DB = previous;
    rmSync(dir, { recursive: true, force: true });
  });
});

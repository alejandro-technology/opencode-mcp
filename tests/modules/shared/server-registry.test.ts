import { beforeEach, describe, expect, it, vi } from "vitest";
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
    killAllServers();
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
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMcpServer } from "../../test-utils/fake-mcp-server.js";
import { getServer, killAllServers, registerServer } from "../shared/server-registry.js";
import { registerOpencodeStopServer } from "./stop_server.js";

describe("opencode_stop_server", () => {
  beforeEach(() => {
    killAllServers();
  });

  it("returns not_found for an unknown server", async () => {
    const fake = createFakeMcpServer();
    registerOpencodeStopServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ server_id: "missing", status: "not_found" }) },
      ],
    });
  });

  it("closes and removes a known server", async () => {
    const close = vi.fn();
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close });
    const fake = createFakeMcpServer();
    registerOpencodeStopServer(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ server_id: "srv-1" });

    expect(close).toHaveBeenCalledOnce();
    expect(getServer("srv-1")).toBeUndefined();
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ server_id: "srv-1", status: "stopped" }) }],
    });
  });
});

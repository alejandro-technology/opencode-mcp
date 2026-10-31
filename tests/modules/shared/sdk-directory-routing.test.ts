import { afterEach, expect, it, vi } from "vitest";
import { clientForServer } from "../../../src/modules/shared/opencode-client.js";
import { killAllServers, registerServer } from "../../../src/modules/shared/server-registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  killAllServers();
});

it("routes CLI2 catalog and session requests to the explicit directory with server auth", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      const body = pathname.endsWith("/agent")
        ? { data: [], location: { directory: "/tmp/project with spaces" } }
        : { data: { id: "session-1" } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const directory = "/tmp/project with spaces";
  registerServer({
    serverId: "routing-server",
    baseUrl: "http://127.0.0.1:4096",
    password: "private-test-password",
    directory,
    close: vi.fn(),
  });
  const client = clientForServer("routing-server");
  if (!client) throw new Error("expected registered server client");

  await client.agent.list({ location: { directory } });
  await client.session.create({ title: "scoped", location: { directory } });

  expect(requests).toHaveLength(2);
  const expectedAuth = `Basic ${Buffer.from("opencode:private-test-password").toString("base64")}`;
  for (const request of requests) expect(request.headers.get("authorization")).toBe(expectedAuth);
  expect(new URL(requests[0].url).searchParams.get("location[directory]")).toBe(directory);
  expect(JSON.parse(await requests[1].clone().text())).toMatchObject({ location: { directory } });
});

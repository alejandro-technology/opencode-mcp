import { createOpencodeClient } from "@opencode-ai/sdk";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("routes SDK GETs through the directory query and mutations through the directory header", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      const body = new URL(request.url).pathname.endsWith("/config/providers")
        ? { providers: [], default: {} }
        : { id: "session-1" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const directory = "/tmp/project with spaces";
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096", directory });

  await client.config.providers();
  await client.session.create({ body: { title: "scoped" } });

  const get = requests[0];
  expect(new URL(get.url).searchParams.get("directory")).toBe(directory);
  expect(get.headers.get("x-opencode-directory")).toBeNull();
  expect(requests[1].headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory));
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatTierGuide,
  formatUsageLimits,
  getCachePath,
  getCacheTtlMs,
  getUsageLimits,
  parseUsageLimits,
  quotaByModelId,
  quotaTier,
  USAGE_LIMITS_SOURCE_URL,
  type UsageLimits,
} from "../../../src/modules/shared/usage-limits.js";

const DOCS_HTML = `
<html>
  <head><style>.x { color: red }</style><script>console.log("nav")</script></head>
  <body>
    <nav><a href="#l">Límites de uso</a></nav>
    <p>OpenCode Go te da acceso por $5 por tu primer mes, luego $10/mes.</p>
    <h2>Límites de uso</h2>
    <ul>
      <li>Límite de 5 horas &mdash; $12 de uso</li>
      <li>Límite semanal &mdash; $30 de uso</li>
      <li>Límite mensual &mdash; $60 de uso</li>
    </ul>
    <table>
      <thead>
        <tr><th>Model</th><th>peticiones por 5 horas</th><th>peticiones por semana</th><th>peticiones por mes</th></tr>
      </thead>
      <tbody>
        <tr><td>Grok 4.5</td><td>120</td><td>300</td><td>600</td></tr>
        <tr><td>GLM-5.2</td><td>880</td><td>2,150</td><td>4,300</td></tr>
        <tr><td>MiMo-V2.5</td><td>30,100</td><td>75,200</td><td>150,400</td></tr>
        <tr><td>Ox Alpha Free</td><td>-</td><td>-</td><td>-</td></tr>
      </tbody>
    </table>
    <p>Las estimaciones se basan en los patrones observados.</p>
  </body>
</html>`;

function limitsFixture(overrides: Partial<UsageLimits> = {}): UsageLimits {
  return {
    source: USAGE_LIMITS_SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    spendBudget: { fiveHours: "$12", weekly: "$30", monthly: "$60" },
    models: [
      { model: "Grok 4.5", perFiveHours: 120, perWeek: 300, perMonth: 600 },
      { model: "GLM-5.2", perFiveHours: 880, perWeek: 2_150, perMonth: 4_300 },
      { model: "MiMo-V2.5", perFiveHours: 30_100, perWeek: 75_200, perMonth: 150_400 },
      { model: "Ox Alpha Free", perFiveHours: null, perWeek: null, perMonth: null },
    ],
    ...overrides,
  };
}

function htmlResponse(body: string) {
  return { ok: true, text: async () => body };
}

describe("getCachePath", () => {
  const envKeys = ["OPENCODE_MCP_CACHE_DIR", "XDG_CACHE_HOME"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("prefers OPENCODE_MCP_CACHE_DIR", () => {
    process.env.OPENCODE_MCP_CACHE_DIR = "/custom/dir";
    expect(getCachePath()).toBe(join("/custom/dir", "usage-limits.json"));
  });

  it("falls back to XDG_CACHE_HOME when the override is blank", () => {
    process.env.OPENCODE_MCP_CACHE_DIR = "   ";
    process.env.XDG_CACHE_HOME = "/xdg/cache";
    expect(getCachePath()).toBe(join("/xdg/cache", "opencode-mcp", "usage-limits.json"));
  });

  it("falls back to ~/.cache when nothing is configured", () => {
    expect(getCachePath()).toBe(join(homedir(), ".cache", "opencode-mcp", "usage-limits.json"));
  });
});

describe("getCacheTtlMs", () => {
  afterEach(() => {
    delete process.env.OPENCODE_MCP_LIMITS_TTL_MS;
  });

  it("defaults to 24 hours", () => {
    expect(getCacheTtlMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("honours a numeric override", () => {
    process.env.OPENCODE_MCP_LIMITS_TTL_MS = "1000";
    expect(getCacheTtlMs()).toBe(1000);
  });

  it("ignores non-numeric and negative overrides", () => {
    process.env.OPENCODE_MCP_LIMITS_TTL_MS = "soon";
    expect(getCacheTtlMs()).toBe(24 * 60 * 60 * 1000);
    process.env.OPENCODE_MCP_LIMITS_TTL_MS = "-5";
    expect(getCacheTtlMs()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("parseUsageLimits", () => {
  it("extracts the spend budget and the per-model quota rows", () => {
    const parsed = parseUsageLimits(DOCS_HTML);

    expect(parsed).not.toBeNull();
    expect(parsed?.spendBudget).toEqual({ fiveHours: "$12", weekly: "$30", monthly: "$60" });
    expect(parsed?.models).toEqual([
      { model: "Grok 4.5", perFiveHours: 120, perWeek: 300, perMonth: 600 },
      { model: "GLM-5.2", perFiveHours: 880, perWeek: 2_150, perMonth: 4_300 },
      { model: "MiMo-V2.5", perFiveHours: 30_100, perWeek: 75_200, perMonth: 150_400 },
      { model: "Ox Alpha Free", perFiveHours: null, perWeek: null, perMonth: null },
    ]);
  });

  it("ignores the subscription price quoted before the section heading", () => {
    expect(parseUsageLimits(DOCS_HTML)?.spendBudget.fiveHours).toBe("$12");
  });

  it("decodes html entities in model names", () => {
    const html = `<table><tr><td>peticiones por 5 horas</td></tr>
      <tr><td>Model &amp; Co &#82; &#x53; &copy;</td><td>10</td><td>20</td><td>30</td></tr></table>`;

    expect(parseUsageLimits(html)?.models[0].model).toBe("Model & Co R S &copy;");
  });

  it("drops out-of-range numeric character references", () => {
    const html = `<table><tr><td>requests per 5 hours</td></tr>
      <tr><td>Model&#x110000;X</td><td>10</td><td>20</td><td>30</td></tr></table>`;

    expect(parseUsageLimits(html)?.models[0].model).toBe("ModelX");
  });

  it("reports null budget entries when the section states no amounts", () => {
    const html = `<p>Usage limits</p><table><tr><td>requests per 5 hours</td></tr>
      <tr><td>Only</td><td>1</td><td>2</td><td>3</td></tr></table>`;

    expect(parseUsageLimits(html)?.spendBudget).toEqual({
      fiveHours: null,
      weekly: null,
      monthly: null,
    });
  });

  it("fills missing budget entries when fewer than three amounts are stated", () => {
    const html = `<p>Usage limits</p><p>5-hour limit — $12 of usage</p>
      <table><tr><td>requests per 5 hours</td></tr>
      <tr><td>Only</td><td>1</td><td>2</td><td>3</td></tr></table>`;

    expect(parseUsageLimits(html)?.spendBudget).toEqual({
      fiveHours: "$12",
      weekly: null,
      monthly: null,
    });
  });

  it("returns null when the quota header is missing", () => {
    expect(parseUsageLimits("<p>no table here</p>")).toBeNull();
  });

  it("returns null when no data row follows the header", () => {
    const html = `<table><tr><td>peticiones por 5 horas</td></tr>
      <tr><td>a</td><td>b</td><td>c</td><td>d</td><td>e</td><td>f</td><td>g</td><td>h</td><td>i</td></tr>
      <tr><td>Grok</td><td>1</td><td>2</td><td>3</td></tr></table>`;

    expect(parseUsageLimits(html)).toBeNull();
  });

  it("treats Unlimited/Ilimitado cells as unmetered and keeps parsing following rows", () => {
    const html = `
      <table>
        <tr><td>peticiones por 5 horas</td></tr>
        <tr><td>Beam Free</td><td>Unlimited</td><td>Ilimitado</td><td>Ilimitados</td></tr>
        <tr><td>Beam Scarce</td><td>100</td><td>250</td><td>500</td></tr>
        <tr><td>Beam Balanced</td><td>1,000</td><td>2,500</td><td>5,000</td></tr>
      </table>`;

    const parsed = parseUsageLimits(html);

    expect(parsed?.models).toEqual([
      { model: "Beam Free", perFiveHours: null, perWeek: null, perMonth: null },
      { model: "Beam Scarce", perFiveHours: 100, perWeek: 250, perMonth: 500 },
      { model: "Beam Balanced", perFiveHours: 1_000, perWeek: 2_500, perMonth: 5_000 },
    ]);
  });
});

describe("getUsageLimits", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "opencode-mcp-cache-"));
    process.env.OPENCODE_MCP_CACHE_DIR = cacheDir;
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.OPENCODE_MCP_CACHE_DIR;
    delete process.env.OPENCODE_MCP_LIMITS_TTL_MS;
    vi.unstubAllGlobals();
  });

  function seedCache(limits: UsageLimits | string): void {
    const body = typeof limits === "string" ? limits : JSON.stringify(limits);
    writeFileSync(join(cacheDir, "usage-limits.json"), body, "utf8");
  }

  it("fetches, parses and persists the snapshot when no cache exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(DOCS_HTML));
    vi.stubGlobal("fetch", fetchMock);

    const limits = await getUsageLimits();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(limits?.source).toBe(USAGE_LIMITS_SOURCE_URL);
    expect(limits?.models).toHaveLength(4);

    const persisted = JSON.parse(readFileSync(join(cacheDir, "usage-limits.json"), "utf8"));
    expect(persisted.models).toHaveLength(4);
  });

  it("serves a fresh cache without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    seedCache(limitsFixture());

    const limits = await getUsageLimits();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(limits?.models[0].model).toBe("Grok 4.5");
  });

  it("refetches once the cache is older than the ttl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(DOCS_HTML));
    vi.stubGlobal("fetch", fetchMock);
    seedCache(limitsFixture({ fetchedAt: new Date(Date.now() - 48 * 3600_000).toISOString() }));

    await getUsageLimits();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats an unparseable timestamp as stale", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(DOCS_HTML));
    vi.stubGlobal("fetch", fetchMock);
    seedCache(limitsFixture({ fetchedAt: "not-a-date" }));

    await getUsageLimits();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the stale snapshot when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    seedCache(limitsFixture({ fetchedAt: "not-a-date" }));

    const limits = await getUsageLimits();

    expect(limits?.models[0].model).toBe("Grok 4.5");
  });

  it("returns null when the response is not ok and nothing is cached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }));

    expect(await getUsageLimits()).toBeNull();
  });

  it("returns null when the page no longer contains the quota table", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("<p>redesigned</p>")));

    expect(await getUsageLimits()).toBeNull();
  });

  it("ignores a corrupt or empty cache file", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(DOCS_HTML));
    vi.stubGlobal("fetch", fetchMock);

    seedCache("{ not json");
    expect((await getUsageLimits())?.models).toHaveLength(4);

    seedCache(JSON.stringify({ fetchedAt: 42, models: [] }));
    expect((await getUsageLimits())?.models).toHaveLength(4);

    seedCache(JSON.stringify({ fetchedAt: new Date().toISOString(), models: "nope" }));
    expect((await getUsageLimits())?.models).toHaveLength(4);

    seedCache(limitsFixture({ models: [] }));
    expect((await getUsageLimits())?.models).toHaveLength(4);
  });

  it("still returns limits when the cache directory cannot be written", async () => {
    process.env.OPENCODE_MCP_CACHE_DIR = join(cacheDir, "not-a-dir.txt", "nested");
    writeFileSync(join(cacheDir, "not-a-dir.txt"), "blocker", "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(DOCS_HTML)));

    expect((await getUsageLimits())?.models).toHaveLength(4);
  });
});

describe("quotaTier", () => {
  it("buckets a model by its 5h request estimate", () => {
    expect(quotaTier(30_100)).toBe("high-volume");
    expect(quotaTier(3_000)).toBe("high-volume");
    expect(quotaTier(2_999)).toBe("balanced");
    expect(quotaTier(500)).toBe("balanced");
    expect(quotaTier(499)).toBe("scarce");
    expect(quotaTier(null)).toBe("free");
  });
});

describe("quotaByModelId", () => {
  it("keys the snapshot by slugified display name", () => {
    const index = quotaByModelId(limitsFixture());

    expect(index.get("grok-4.5")?.perFiveHours).toBe(120);
    expect(index.get("mimo-v2.5")?.perFiveHours).toBe(30_100);
    expect(index.get("ox-alpha-free")?.perFiveHours).toBeNull();
    expect(index.get("Grok 4.5")).toBeUndefined();
  });

  it("slugifies multi-word display names the way opencode ids are spelled", () => {
    const index = quotaByModelId(
      limitsFixture({
        models: [
          {
            model: "Muse Spark 1.2 Contributor",
            perFiveHours: 45_300,
            perWeek: 113_300,
            perMonth: 226_600,
          },
        ],
      }),
    );

    expect(index.has("muse-spark-1.2-contributor")).toBe(true);
  });

  it("indexes models under both dot-preserving and dot-to-dash slugs", () => {
    const index = quotaByModelId(
      limitsFixture({
        models: [
          {
            model: "Claude Haiku 5.5",
            perFiveHours: 5_000,
            perWeek: 12_500,
            perMonth: 25_000,
          },
        ],
      }),
    );

    expect(index.get("claude-haiku-5.5")?.perFiveHours).toBe(5_000);
    expect(index.get("claude-haiku-5-5")?.perFiveHours).toBe(5_000);
  });
});

describe("formatUsageLimits", () => {
  it("cites the source and the shared spend budget", () => {
    const text = formatUsageLimits(limitsFixture({ fetchedAt: "2026-08-21T10:00:00.000Z" }));

    expect(text).toContain(`source: ${USAGE_LIMITS_SOURCE_URL} (checked 2026-08-21)`);
    expect(text).toContain("Shared spend budget: $12 per 5 hours, $30 per week, $60 per month.");
  });

  it("leaves the per-model numbers out — list_agents reports them by model id", () => {
    const text = formatUsageLimits(limitsFixture());

    expect(text).not.toContain("Grok 4.5");
    expect(text).not.toContain("30,100");
  });

  it("describes the budget generically when no amounts were published", () => {
    const text = formatUsageLimits(
      limitsFixture({ spendBudget: { fiveHours: null, weekly: null, monthly: null } }),
    );

    expect(text).toContain("Shared spend budget across all models.");
  });

  it("renders only the budget windows that are known", () => {
    const text = formatUsageLimits(
      limitsFixture({ spendBudget: { fiveHours: null, weekly: "$30", monthly: null } }),
    );

    expect(text).toContain("Shared spend budget: $30 per week.");
  });
});

describe("formatTierGuide", () => {
  it("lists every tier keyed by the exact value list_agents reports", () => {
    const guide = formatTierGuide();

    expect(guide).toContain("- high-volume: 3,000+ req/5h — default:");
    expect(guide).toContain("- balanced: 500-2,999 req/5h —");
    expect(guide).toContain("- scarce: under 500 req/5h —");
    expect(guide).toContain("- free: unlimited req/5h (free model)");
    expect(guide.split("\n")).toHaveLength(4);
  });
});

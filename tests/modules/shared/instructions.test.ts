import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegateTaskInstructions } from "../../../src/modules/shared/instructions.js";
import type { UsageLimits } from "../../../src/modules/shared/usage-limits.js";

const { getUsageLimitsMock } = vi.hoisted(() => ({
  getUsageLimitsMock: vi.fn<() => Promise<UsageLimits | null>>(),
}));

vi.mock("../../../src/modules/shared/usage-limits.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/modules/shared/usage-limits.js")>();
  return { ...actual, getUsageLimits: getUsageLimitsMock };
});

const LIMITS: UsageLimits = {
  source: "https://opencode.ai/docs/es/go/#límites-de-uso",
  fetchedAt: "2026-08-21T10:00:00.000Z",
  spendBudget: { fiveHours: "$12", weekly: "$30", monthly: "$60" },
  models: [
    { model: "Grok 4.5", perFiveHours: 120, perWeek: 300, perMonth: 600 },
    { model: "MiMo-V2.5", perFiveHours: 30_100, perWeek: 75_200, perMonth: 150_400 },
  ],
};

describe("createDelegateTaskInstructions", () => {
  beforeEach(() => {
    getUsageLimitsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells the agent to build ids only from list_agents output", async () => {
    getUsageLimitsMock.mockResolvedValue(LIMITS);

    const instructions = await createDelegateTaskInstructions();

    expect(instructions).toContain(
      "models.providers[].provider + '/' + models.providers[].models[].id",
    );
    expect(instructions).toContain("both copied verbatim");
    expect(instructions).toContain("unknown_model");
    expect(instructions).toContain(
      "Usage reports aggregate only direct assistant-message INFO metrics",
    );
    expect(instructions).toContain(
      "Historical results retain the usage snapshot captured at run finalization",
    );
  });

  it("embeds the live spend budget and the tier legend", async () => {
    getUsageLimitsMock.mockResolvedValue(LIMITS);

    const instructions = await createDelegateTaskInstructions();

    expect(instructions).toContain("checked 2026-08-21");
    expect(instructions).toContain("Shared spend budget: $12 per 5 hours");
    expect(instructions).toContain("- high-volume: 3,000+ req/5h");
    expect(instructions).toContain("- scarce: under 500 req/5h");
  });

  it("does not restate the per-model quotas that list_agents already reports", async () => {
    getUsageLimitsMock.mockResolvedValue(LIMITS);

    const instructions = await createDelegateTaskInstructions();

    expect(instructions).not.toContain("Grok 4.5");
    expect(instructions).not.toContain("30,100");
    // The tier-to-task mapping must appear exactly once.
    expect(instructions.match(/exploration/g)).toHaveLength(1);
  });

  it("degrades to a quota-aware fallback when the limits cannot be resolved", async () => {
    getUsageLimitsMock.mockResolvedValue(null);

    const instructions = await createDelegateTaskInstructions();

    expect(instructions).toContain("OpenCode Go usage limits — unavailable right now");
    // The tier legend is static, so it survives a failed fetch.
    expect(instructions).toContain("- balanced: 500-2,999 req/5h");
    expect(instructions).toContain("opencode_wait_for_task");
  });
});

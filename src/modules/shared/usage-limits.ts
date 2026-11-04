import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Page scraped for the OpenCode Go quota table. */
const FETCH_URL = "https://opencode.ai/docs/es/go/";
/** Same page, anchored at the section we read — shown as the citation. */
export const USAGE_LIMITS_SOURCE_URL = "https://opencode.ai/docs/es/go/#límites-de-uso";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE_NAME = "usage-limits.json";

/** Requests per 5h above which a model is treated as effectively cheap. */
export const HIGH_VOLUME_MIN = 3_000;
/** Requests per 5h below which a model is treated as scarce. */
const BALANCED_MIN = 500;

/** Header cell that identifies the quota table (Spanish or English docs). */
const QUOTA_HEADER = /peticiones por 5\s*horas|requests per 5\s*hours/i;
/** Heading that opens the usage-limits section. */
const SECTION_HEADING = /^(l[ií]mites de uso|usage limits)$/i;
/** How many lines after the header may still be header cells. */
const HEADER_SCAN_WINDOW = 8;

const COUNT_PATTERN = /^\d{1,3}(?:,\d{3})*$|^\d+$/;
const EMPTY_CELL_PATTERN = /^(?:[-–—]|unlimited|ilimitad[oa]s?)$/i;
const SPEND_PATTERN = /\$\s?\d+(?:[.,]\d+)?/g;

export type ModelQuota = {
  model: string;
  /** `null` when the docs list the quota as unmetered or unknown. */
  perFiveHours: number | null;
  perWeek: number | null;
  perMonth: number | null;
};

export type SpendBudget = {
  fiveHours: string | null;
  weekly: string | null;
  monthly: string | null;
};

export type UsageLimits = {
  source: string;
  /** ISO timestamp of the fetch that produced this snapshot. */
  fetchedAt: string;
  spendBudget: SpendBudget;
  models: ModelQuota[];
};

/**
 * Resolve where the daily snapshot is persisted.
 *
 * Precedence: `OPENCODE_MCP_CACHE_DIR` > `XDG_CACHE_HOME` > `~/.cache`, always
 * under an `opencode-mcp/` subdirectory. Read lazily so tests can redirect it.
 */
export function getCachePath(): string {
  const override = process.env.OPENCODE_MCP_CACHE_DIR?.trim();
  if (override) return join(override, CACHE_FILE_NAME);

  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg ? xdg : join(homedir(), ".cache");
  return join(base, "opencode-mcp", CACHE_FILE_NAME);
}

/** Snapshot lifetime in ms; `OPENCODE_MCP_LIMITS_TTL_MS` overrides the 24h default. */
export function getCacheTtlMs(): number {
  const raw = process.env.OPENCODE_MCP_LIMITS_TTL_MS?.trim();
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_MS;
  return parsed;
}

/**
 * Return the OpenCode Go usage limits, fetching the docs at most once a day.
 *
 * A fresh cache entry short-circuits the network. On a fetch or parse failure
 * a stale cache entry is still returned, so an offline start degrades to
 * yesterday's numbers instead of no numbers at all. Returns `null` only when
 * there is neither a usable cache nor a usable response.
 */
export async function getUsageLimits(): Promise<UsageLimits | null> {
  const cached = readCache();
  if (cached && !isStale(cached)) return cached;

  const fetched = await fetchUsageLimits();
  if (!fetched) return cached;

  writeCache(fetched);
  return fetched;
}

function isStale(limits: UsageLimits): boolean {
  const fetchedAt = Date.parse(limits.fetchedAt);
  if (Number.isNaN(fetchedAt)) return true;
  return Date.now() - fetchedAt >= getCacheTtlMs();
}

async function fetchUsageLimits(): Promise<UsageLimits | null> {
  let html: string;
  try {
    const response = await fetch(FETCH_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/html" },
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  const parsed = parseUsageLimits(html);
  if (!parsed) return null;

  return {
    source: USAGE_LIMITS_SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    ...parsed,
  };
}

/**
 * Pull the spend budget and the per-model request estimates out of the docs
 * HTML. Returns `null` when the quota table is missing or unrecognisable, so a
 * page redesign falls back to the cache instead of injecting garbage.
 */
export function parseUsageLimits(html: string): Omit<UsageLimits, "source" | "fetchedAt"> | null {
  const lines = htmlToLines(html);
  const headerIndex = lines.findIndex((line) => QUOTA_HEADER.test(line));
  if (headerIndex === -1) return null;

  const models = parseQuotaRows(lines, headerIndex);
  if (models.length === 0) return null;

  return { spendBudget: parseSpendBudget(lines, headerIndex), models };
}

/** Strip scripts, styles and tags, leaving one trimmed text node per line. */
function htmlToLines(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map(decodeEntities)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lowered = entity.toLowerCase();
    if (lowered.startsWith("#x")) return codePointToChar(Number.parseInt(entity.slice(2), 16));
    if (lowered.startsWith("#")) return codePointToChar(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[lowered] ?? match;
  });
}

function codePointToChar(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

/**
 * Read the table as flat text: every row is a model name followed by three
 * count cells, so a row is anything with three numeric-ish lines behind it.
 */
function parseQuotaRows(lines: string[], headerIndex: number): ModelQuota[] {
  let index = headerIndex + 1;
  const scanLimit = Math.min(lines.length, headerIndex + 1 + HEADER_SCAN_WINDOW);
  while (index < scanLimit && !isRowStart(lines, index)) index++;

  const rows: ModelQuota[] = [];
  while (isRowStart(lines, index)) {
    rows.push({
      model: lines[index],
      perFiveHours: toCount(lines[index + 1]),
      perWeek: toCount(lines[index + 2]),
      perMonth: toCount(lines[index + 3]),
    });
    index += 4;
  }
  return rows;
}

function isRowStart(lines: string[], index: number): boolean {
  const name = lines[index];
  if (name === undefined || isCountCell(name)) return false;
  return (
    isCountCell(lines[index + 1]) && isCountCell(lines[index + 2]) && isCountCell(lines[index + 3])
  );
}

function isCountCell(cell: string | undefined): boolean {
  if (cell === undefined) return false;
  return COUNT_PATTERN.test(cell) || EMPTY_CELL_PATTERN.test(cell);
}

function toCount(cell: string): number | null {
  if (!COUNT_PATTERN.test(cell)) return null;
  return Number(cell.replace(/,/g, ""));
}

/**
 * The three dollar figures stated above the table, in doc order.
 *
 * Anchored on the LAST heading before the table: the page repeats the section
 * title in its navigation, and the subscription price ($5 first month, $10/mo)
 * sits between that nav copy and the real section.
 */
function parseSpendBudget(lines: string[], headerIndex: number): SpendBudget {
  let start = 0;
  for (let index = headerIndex - 1; index >= 0; index--) {
    if (SECTION_HEADING.test(lines[index])) {
      start = index;
      break;
    }
  }
  const amounts = lines
    .slice(start, headerIndex)
    .join(" ")
    .match(SPEND_PATTERN)
    ?.map((amount) => amount.replace(/\s/g, ""));

  return {
    fiveHours: amounts?.[0] ?? null,
    weekly: amounts?.[1] ?? null,
    monthly: amounts?.[2] ?? null,
  };
}

function readCache(): UsageLimits | null {
  try {
    const parsed = JSON.parse(readFileSync(getCachePath(), "utf8")) as UsageLimits;
    if (typeof parsed?.fetchedAt !== "string" || !Array.isArray(parsed?.models)) return null;
    if (parsed.models.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(limits: UsageLimits): void {
  const path = getCachePath();
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(limits, null, 2)}\n`, "utf8");
  } catch {
    // A read-only cache directory must not stop the server from starting; the
    // only cost is re-fetching on the next boot.
  }
}

/** How costly one request is against the shared budget, cheapest tier first. */
export type QuotaTier = "high-volume" | "free" | "balanced" | "scarce";

const TIER_ORDER: readonly QuotaTier[] = ["high-volume", "free", "balanced", "scarce"];

// Keyed by the exact `tier` value that opencode_list_agents reports per model,
// so the reading agent can match the JSON value to its guidance literally.
const TIER_GUIDE: Record<QuotaTier, string> = {
  "high-volume":
    "3,000+ req/5h — default: exploration, mechanical edits, boilerplate, docs, tests, simple fixes",
  free: "unlimited req/5h (free model) — zero budget cost; use freely for high-volume work",
  balanced: "500-2,999 req/5h — standard features, non-trivial debugging, code review",
  scarce:
    "under 500 req/5h — architecture, cross-cutting refactors, hard debugging; use only for the step that needs it",
};

/** Bucket a model by its 5h request estimate. Thresholds live here only. */
export function quotaTier(perFiveHours: number | null): QuotaTier {
  if (perFiveHours === null) return "free";
  if (perFiveHours >= HIGH_VOLUME_MIN) return "high-volume";
  if (perFiveHours >= BALANCED_MIN) return "balanced";
  return "scarce";
}

/**
 * Index the snapshot by slugified display name so a live model id from an
 * OpenCode server (`mimo-v2.5`) joins onto the docs row (`MiMo-V2.5`).
 *
 * Verified against a real server: all 22 `opencode-go` model ids match this
 * way. Ids with no row (the free/preview models on the `opencode` provider)
 * are simply absent, which callers report as "no published quota".
 */
export function quotaByModelId(limits: UsageLimits): Map<string, ModelQuota> {
  const index = new Map<string, ModelQuota>();
  for (const model of limits.models) {
    const slug = slugifyModelName(model.model);
    index.set(slug.replace(/\./g, "-"), model);
    index.set(slug, model);
  }
  return index;
}

function slugifyModelName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Render the live half of the quota guidance: where the numbers came from and
 * the shared dollar budget every model spends against.
 *
 * The per-model numbers deliberately stay OUT of the instructions —
 * opencode_list_agents reports them per model, keyed by the real model id,
 * which is the only form the agent can act on.
 */
export function formatUsageLimits(limits: UsageLimits): string {
  return [
    `OpenCode Go usage limits — source: ${limits.source} (checked ${limits.fetchedAt.slice(0, 10)})`,
    renderBudget(limits.spendBudget),
  ].join("\n");
}

/** Render the static tier legend, one line per `tier` value list_agents emits. */
export function formatTierGuide(): string {
  return TIER_ORDER.map((tier) => `- ${tier}: ${TIER_GUIDE[tier]}`).join("\n");
}

function renderBudget(budget: SpendBudget): string {
  const parts = [
    budget.fiveHours ? `${budget.fiveHours} per 5 hours` : null,
    budget.weekly ? `${budget.weekly} per week` : null,
    budget.monthly ? `${budget.monthly} per month` : null,
  ].filter((part) => part !== null);

  const shared =
    "Every model draws from the SAME dollar budget, so an expensive model drains it in far fewer requests.";
  if (parts.length === 0) return `Shared spend budget across all models. ${shared}`;
  return `Shared spend budget: ${parts.join(", ")}. ${shared}`;
}

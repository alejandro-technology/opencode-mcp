const DEFAULT_MAX_TIMEOUT_MS = 300_000;

/**
 * Resolve the configurable max clamp (ms) for tool wait timeouts.
 *
 * Precedence: the `MCP_TOOL_TIMEOUT` environment variable wins over an
 * `MCP_TOOL_TIMEOUT=<ms>` CLI arg, which wins over the built-in default of
 * 300000ms (5 min). Invalid/non-numeric values fall back to the default.
 *
 * Reads `process.env` / `process.argv` lazily on each call so tests can vary
 * them between invocations without module re-import tricks.
 */
export function getMaxToolTimeoutMs(): number {
  const fromEnv = parsePositiveInt(process.env.MCP_TOOL_TIMEOUT);
  if (fromEnv !== undefined) return fromEnv;

  const argPrefix = "MCP_TOOL_TIMEOUT=";
  const argEntry = process.argv.find((arg) => arg.startsWith(argPrefix));
  if (argEntry !== undefined) {
    const fromArg = parsePositiveInt(argEntry.slice(argPrefix.length));
    if (fromArg !== undefined) return fromArg;
  }

  return DEFAULT_MAX_TIMEOUT_MS;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

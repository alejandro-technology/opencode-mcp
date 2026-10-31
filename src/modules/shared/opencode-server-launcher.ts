/**
 * Standalone supervisor for `opencode serve`.
 *
 * Run directly from either source or build output. The CLI exec lives at this
 * file's top level so child startup and shutdown ownership are unambiguous.
 */
import { spawn } from "node:child_process";

export function isOpencodeLauncherMain(entrypoint: string | undefined): boolean {
  return /opencode-server-launcher\.(?:ts|js)$/.test(entrypoint ?? "");
}

if (isOpencodeLauncherMain(process.argv[1])) await runLauncher();

export async function runLauncher() {
  const [hostname, port] = process.argv.slice(2);
  if (!hostname || !port) {
    console.error("usage: opencode-server-launcher.js <hostname> <port>");
    process.exit(2);
  }
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    console.error("launcher: missing private server password");
    process.exit(2);
  }

  const server = spawn("opencode", [`serve`, `--hostname=${hostname}`, `--port=${port}`], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stopping = false;
  const stopServer = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    server.kill(signal);
  };
  process.on("SIGTERM", () => stopServer("SIGTERM"));
  process.on("SIGINT", () => stopServer("SIGINT"));
  server.on("error", (error: Error) => {
    console.error(`launcher: server spawn error: ${error.message}`);
    process.exit(1);
  });
  server.on("exit", (code, signal) => {
    if (!stopping) console.error(`launcher: server exited (${signal ?? code})`);
    process.exit(code ?? 1);
  });

  // Install orphan cleanup before waiting for readiness: the host may disappear
  // while startup is still in progress.
  const watchdog = setInterval(() => {
    if (process.ppid === 1) {
      stopServer("SIGTERM");
      clearInterval(watchdog);
      process.exit(0);
    }
  }, 1_000);
  watchdog.unref?.();

  const serverUrl = `http://${hostname}:${port}`;
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const deadline = Date.now() + 20_000;
  let serverVersion: string | undefined;
  while (Date.now() < deadline) {
    try {
      const infoResponse = await fetch(`${serverUrl}/api/info`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(1_000),
      });
      if (infoResponse.ok) {
        const info = (await infoResponse.json()) as { version?: unknown; pid?: unknown };
        if (info.pid !== server.pid) throw new Error("OpenCode API belongs to another process");
        if (typeof info.version !== "string") throw new Error("OpenCode API omitted its version");
        const version = /^v?(\d+)\.(\d+)\.(\d+)/.exec(info.version);
        if (!version || Number(version[1]) !== 2 || Number(version[2]) < 2) {
          throw new Error(
            `Unsupported OpenCode CLI version ${info.version}; this MCP requires OpenCode >=2.2 and <3`,
          );
        }
        // /api/info is intentionally public; verify the private password on a
        // protected endpoint before accepting the listener as our own server.
        const locationResponse = await fetch(`${serverUrl}/api/location`, {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(1_000),
        });
        if (!locationResponse.ok) continue;
        serverVersion = info.version;
        break;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Unsupported OpenCode CLI")) {
        console.error(`launcher: ${error.message}`);
        stopServer("SIGTERM");
        return;
      }
      if (error instanceof Error && error.message.includes("belongs to another process")) {
        console.error("launcher: listener is not the spawned OpenCode server");
        stopServer("SIGTERM");
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!serverVersion) {
    console.error("launcher: authenticated OpenCode API not ready after 20000ms");
    stopServer("SIGTERM");
    return;
  }
  console.log(`ready ${server.pid} ${serverVersion}`);
}

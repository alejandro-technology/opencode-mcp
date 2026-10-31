import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";

export interface OpencodeServerProcess {
  url: string;
  password: string;
  close: () => void;
}

/** How long to wait for the launcher to report a ready server. */
const READY_TIMEOUT_MS = 25_000;

/**
 * Start an `opencode serve` child and wait until its HTTP endpoint answers.
 *
 * Readiness is probed via HTTP instead of parsing stdout: the CLI's banner
 * changed at least once ("opencode server listening..." -> "server listening
 * on ..."), which made the SDK's stdout-matching readiness check time out on a
 * healthy server and kill it. A port probe works regardless of banner format.
 *
 * The CLI is exec'd by `opencode-server-launcher.js` (see that file for why the
 * exec must happen at a launcher's top level). This function supervises the
 * launcher process only.
 */
export function launcherPathFor(importUrl: string): string {
  const extension = importUrl.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./opencode-server-launcher${extension}`, importUrl));
}

export async function createOpencodeServer(options: {
  hostname: string;
  port: number;
}): Promise<OpencodeServerProcess> {
  const launcherPath = launcherPathFor(import.meta.url);

  // Pipe only stdout (the "ready <pid>" token); stderr inherits so CLI
  // diagnostics stay visible in MCP debug logs without blocking the child.
  const password = process.env.OPENCODE_SERVER_PASSWORD || randomBytes(32).toString("base64url");
  const launcher = spawn(process.execPath, [launcherPath, options.hostname, String(options.port)], {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const serverPid = await new Promise<number>((resolve, reject) => {
    const output: string[] = [];
    const timer = setTimeout(() => {
      cleanup();
      launcher.kill("SIGTERM");
      reject(
        new Error(
          `OpenCode server not ready after ${READY_TIMEOUT_MS}ms ${
            output.length ? `Output: ${output.join("").trim()}` : "(no launcher output)"
          }`,
        ),
      );
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      const match = /ready (\d+) (\S+)/.exec(text);
      if (match) {
        clearTimeout(timer);
        cleanup();
        resolve(Number(match[1]));
      }
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      cleanup();
      reject(
        new Error(`launcher exited before readiness (code ${code}) ${output.join("").trim()}`),
      );
    };
    const cleanup = () => {
      launcher.stdout?.off("data", onData);
      launcher.off("error", onError);
      launcher.off("exit", onExit);
    };
    launcher.stdout?.on("data", onData);
    launcher.on("error", onError);
    launcher.on("exit", onExit);
  });

  const serverUrl = `http://${options.hostname}:${options.port}`;
  try {
    const client = OpenCode.make({
      baseUrl: serverUrl,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    });
    const info = await client.server.info({ signal: AbortSignal.timeout(5_000) });
    const version = /^v?(\d+)\.(\d+)\.(\d+)/.exec(info.version);
    if (!version || Number(version[1]) !== 2 || Number(version[2]) < 2) {
      throw new Error(
        `Unsupported OpenCode CLI version ${info.version}; this MCP requires OpenCode >=2.2 and <3`,
      );
    }
    if (info.pid !== serverPid) throw new Error("OpenCode API listener belongs to another process");
    await client.location.get(undefined, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    try {
      process.kill(serverPid, "SIGTERM");
    } catch {
      // Already gone.
    }
    try {
      launcher.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    throw new Error(
      `OpenCode CLI compatibility check failed at ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    url: serverUrl,
    password,
    close: () => {
      // Child first (it may outlive the launcher), then the launcher tree.
      try {
        process.kill(serverPid, "SIGTERM");
      } catch {
        // Already gone.
      }
      try {
        launcher.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
}

export const opencodeLauncherPath = launcherPathFor(import.meta.url);

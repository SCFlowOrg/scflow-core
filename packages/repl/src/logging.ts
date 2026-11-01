import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "@scfloworg/core";
import type { Logger, LogLevel } from "@scfloworg/core";

/**
 * File- and console-backed `Logger` sinks for this package: the Node-specific
 * half of logging. `createLogger` of `@scfloworg/core` supplies the shared,
 * I/O-free level gate; this file supplies the `write` function it wraps. The
 * sinks are deliberately not shared with `@scfloworg/mcp`, which holds a
 * sibling implementation: each package stays decoupled from the other. A
 * third consumer would be the trigger to factor the sinks out into a package
 * of their own.
 *
 * Console output goes to stderr, never stdout, because stdout carries the
 * REPL's interactive output and a log line there would interleave with a
 * prompt or a command's printed result. The REPL logs to stderr by default,
 * since an operator is watching the session; `--log-file <path>` opts into a
 * file.
 */

/**
 * The default log directory for the platform, computed from `process.platform`
 * and `os.homedir()` alone: `%APPDATA%\<appName>\logs` on Windows,
 * `~/Library/Logs/<appName>` on macOS, and `$XDG_STATE_HOME/<appName>/logs`
 * (falling back to `~/.local/state`) elsewhere.
 */
export function defaultLogDir(appName = "scfloworg"): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, appName, "logs");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", appName);
  }
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, appName, "logs");
}

/** `repl.log` in `defaultLogDir()`. */
export function defaultLogPath(): string {
  return join(defaultLogDir(), "repl.log");
}

/** One JSON object per line: `{ts, level, msg, ...context}`. */
function formatLine(level: LogLevel, message: string, context: Record<string, unknown> | undefined): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...context });
}

/** A `Logger` writing to a file, which `close()` flushes and closes. */
export interface FileLogger extends Logger {
  /** Flushes and closes the underlying file. */
  close(): Promise<void>;
}

/**
 * Opens `filePath` for appending, creating its directory first if needed, and
 * returns a `Logger` that writes one JSON line per call.
 *
 * @param initialLevel - the starting level; defaults to `"warn"`.
 */
export async function createFileLogger(filePath: string, initialLevel: LogLevel = "warn"): Promise<FileLogger> {
  await mkdir(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a" });
  const logger = createLogger((level, message, context) => {
    stream.write(formatLine(level, message, context) + "\n");
  }, initialLevel) as FileLogger;
  logger.close = () =>
    new Promise((resolve, reject) => {
      stream.end((err: unknown) => (err ? reject(err as Error) : resolve()));
    });
  return logger;
}

/**
 * Returns a `Logger` that writes each line to stderr as
 * `[level] message {context}`.
 *
 * @param initialLevel - the starting level; defaults to `"warn"`.
 */
export function createConsoleLogger(initialLevel: LogLevel = "warn"): Logger {
  return createLogger((level, message, context) => {
    const suffix = context ? ` ${JSON.stringify(context)}` : "";
    process.stderr.write(`[${level}] ${message}${suffix}\n`);
  }, initialLevel);
}

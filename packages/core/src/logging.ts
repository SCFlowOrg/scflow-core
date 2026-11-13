/**
 * The `Logger` interface consumed across the modelling language and its
 * hosts (`@scfloworg/cli`, `@scfloworg/mcp`) — deliberately I/O-free.
 * `@scfloworg/core` also runs in the browser (the `app_framework` project's
 * web target), so no sink lives here: a host supplies a `write` function to
 * `createLogger` and gets back a `Logger` whose level gate is shared, and
 * whose `level` is a plain mutable property — assigning it directly is the
 * whole mechanism a host uses to change verbosity at runtime, no restart
 * required.
 */

/** A log level, from the least to the most severe: `debug`, `info`, `warn`, `error`. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Whether `value` is one of the four `LogLevel`s. */
export function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/** A leveled logger: `log` reaches the host's sink only when its level is at or above `level`. */
export interface Logger {
  /** Mutable — a host toggles verbosity by assigning it directly (`logger.level = "debug"`); `log` reads it fresh on every call. */
  level: LogLevel;
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
}

/**
 * Wraps a raw `write` function — the only thing a host has to supply — with
 * the shared level gate: `write` only ever sees a call at or above the
 * returned `Logger`'s current `level`. `write` is looked up through the
 * closure over the returned object itself (not copied out), so mutating
 * `logger.level` after the fact — from a CLI flag's initial value, a running
 * REPL's `log-level` meta-command, or an MCP `set_log_level` tool call —
 * takes effect on the very next `log` call, whatever reference is used to
 * make it.
 */
export function createLogger(
  write: (level: LogLevel, message: string, context: Record<string, unknown> | undefined) => void,
  initialLevel: LogLevel = "info",
): Logger {
  const logger: Logger = {
    level: initialLevel,
    log(level, message, context) {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[logger.level]) return;
      write(level, message, context);
    },
  };
  return logger;
}

/** A `Logger` that discards everything — `@scfloworg/core`'s own default, and every host's default before it wires up a real sink. */
export const noopLogger: Logger = createLogger(() => {}, "error");

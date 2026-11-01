import { describe, expect, it } from "vitest";
import { createLogger, isLogLevel, noopLogger } from "../src/logging.js";
import type { LogLevel } from "../src/logging.js";

describe("isLogLevel", () => {
  it("accepts the four known levels", () => {
    for (const level of ["debug", "info", "warn", "error"] as LogLevel[]) {
      expect(isLogLevel(level)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isLogLevel("trace")).toBe(false);
    expect(isLogLevel("")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel(3)).toBe(false);
  });
});

describe("createLogger", () => {
  it("defaults to level info", () => {
    const logger = createLogger(() => {});
    expect(logger.level).toBe("info");
  });

  it("calls write for a message at or above the current level", () => {
    const calls: unknown[] = [];
    const logger = createLogger((level, message, context) => calls.push({ level, message, context }), "info");
    logger.log("info", "hello");
    logger.log("warn", "careful", { code: "x" });
    logger.log("error", "boom");
    expect(calls).toEqual([
      { level: "info", message: "hello", context: undefined },
      { level: "warn", message: "careful", context: { code: "x" } },
      { level: "error", message: "boom", context: undefined },
    ]);
  });

  it("discards a message below the current level", () => {
    const calls: unknown[] = [];
    const logger = createLogger((level, message) => calls.push({ level, message }), "warn");
    logger.log("debug", "too quiet");
    logger.log("info", "still too quiet");
    expect(calls).toEqual([]);
  });

  it("picks up a level change on the very next call, whatever reference calls log", () => {
    const calls: string[] = [];
    const logger = createLogger((level, message) => calls.push(message), "warn");
    const { log } = logger; // a destructured reference, not the object itself
    logger.log("debug", "before");
    logger.level = "debug";
    logger.log("debug", "after via logger.log");
    log("debug", "after via destructured log");
    expect(calls).toEqual(["after via logger.log", "after via destructured log"]);
  });
});

describe("noopLogger", () => {
  it("discards every call, at every level", () => {
    // No assertion beyond "doesn't throw" is really possible against a
    // pure sink with no observable effect — this exists so a caller can
    // hand noopLogger to something expecting a Logger without wiring up a
    // real one, which is exercised throughout mcp/repl's own tests.
    expect(() => {
      noopLogger.log("debug", "ignored");
      noopLogger.log("error", "also ignored", { any: "context" });
    }).not.toThrow();
  });
});

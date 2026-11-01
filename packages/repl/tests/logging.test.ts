import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConsoleLogger, createFileLogger, defaultLogDir, defaultLogPath } from "../src/logging.js";

describe("defaultLogDir/defaultLogPath", () => {
  it("computes an OS-appropriate directory and appends repl.log", () => {
    expect(defaultLogPath()).toBe(join(defaultLogDir(), "repl.log"));
  });

  it("uses XDG_STATE_HOME on linux when set", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/home/rem/.state";
    try {
      expect(defaultLogDir()).toBe(join("/home/rem/.state", "scfloworg", "logs"));
    } finally {
      spy.mockRestore();
      process.env.XDG_STATE_HOME = prev;
    }
  });
});

describe("createFileLogger", () => {
  it("defaults to level warn, and appends JSON lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repl-logging-"));
    const file = join(dir, "repl.log");
    const logger = await createFileLogger(file);
    expect(logger.level).toBe("warn");
    try {
      logger.log("info", "ignored at default level");
      logger.log("warn", "kept", { dataset: "kb" });
    } finally {
      await logger.close();
    }
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "warn", msg: "kept", dataset: "kb" });
  });
});

describe("createConsoleLogger", () => {
  it("writes to stderr, never stdout", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const logger = createConsoleLogger("info");
      logger.log("info", "hello");
      expect(errSpy).toHaveBeenCalledWith("[info] hello\n");
      expect(outSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
  });
});

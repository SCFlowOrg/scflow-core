import { describe, expect, it } from "vitest";
import { cliHelpLines, parseCliArgs } from "../src/cliArgs.js";

describe("parseCliArgs", () => {
  it("parses no arguments", () => {
    expect(parseCliArgs([])).toEqual({ formatModules: [], logLevel: "warn" });
  });

  it("parses --init with a file", () => {
    expect(parseCliArgs(["--init", "init.txt"])).toEqual({
      initFile: "init.txt",
      formatModules: [],
      logLevel: "warn",
    });
  });

  it("rejects --init given more than once", () => {
    expect(() => parseCliArgs(["--init", "a.txt", "--init", "b.txt"])).toThrow(/only be given once/);
  });

  it("rejects --init missing its file", () => {
    expect(() => parseCliArgs(["--init"])).toThrow(/requires <file>/);
  });

  it("rejects --init followed by another flag instead of a file", () => {
    expect(() => parseCliArgs(["--init", "--format-module", "pkg"])).toThrow(/requires <file>/);
  });

  it("parses a single --format-module", () => {
    expect(parseCliArgs(["--format-module", "some-format-pkg"])).toEqual({
      formatModules: ["some-format-pkg"],
      logLevel: "warn",
    });
  });

  it("parses repeated --format-module flags, preserving order", () => {
    expect(parseCliArgs(["--format-module", "pkg-a", "--format-module", "pkg-b"])).toEqual({
      formatModules: ["pkg-a", "pkg-b"],
      logLevel: "warn",
    });
  });

  it("rejects --format-module missing its specifier", () => {
    expect(() => parseCliArgs(["--format-module"])).toThrow(/requires <specifier>/);
  });

  it("parses --init and --format-module together, in either order", () => {
    expect(parseCliArgs(["--format-module", "pkg-a", "--init", "init.txt"])).toEqual({
      initFile: "init.txt",
      formatModules: ["pkg-a"],
      logLevel: "warn",
    });
    expect(parseCliArgs(["--init", "init.txt", "--format-module", "pkg-a"])).toEqual({
      initFile: "init.txt",
      formatModules: ["pkg-a"],
      logLevel: "warn",
    });
  });

  it("reads --log-file", () => {
    expect(parseCliArgs(["--log-file", "repl.log"]).logFile).toBe("repl.log");
  });

  it("rejects --log-file missing its path", () => {
    expect(() => parseCliArgs(["--log-file"])).toThrow(/requires <path>/);
    expect(() => parseCliArgs(["--log-file", "--init", "x"])).toThrow(/requires <path>/);
  });

  it("reads --log-level, one of debug/info/warn/error", () => {
    expect(parseCliArgs(["--log-level", "debug"]).logLevel).toBe("debug");
    expect(parseCliArgs(["--log-level", "error"]).logLevel).toBe("error");
  });

  it("rejects an unknown --log-level", () => {
    expect(() => parseCliArgs(["--log-level", "verbose"])).toThrow(/debug, info, warn, error/);
    expect(() => parseCliArgs(["--log-level"])).toThrow(/debug, info, warn, error/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow(/unknown argument/);
  });

  it("recognizes --help and -h", () => {
    expect(parseCliArgs(["--help"])).toEqual({ help: true, formatModules: [], logLevel: "warn" });
    expect(parseCliArgs(["-h"])).toEqual({ help: true, formatModules: [], logLevel: "warn" });
  });

  it("cliHelpLines returns non-empty usage text", () => {
    expect(cliHelpLines().length).toBeGreaterThan(0);
    expect(cliHelpLines()[0]).toContain("Usage:");
  });
});

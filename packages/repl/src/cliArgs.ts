/**
 * Command-line argument parsing for `cli.ts`, kept separate and pure so it is
 * unit-testable without readline or stdin.
 *
 * Usage: model-repl [--init <file>] [--format-module <specifier>]... [--log-file <path>] [--log-level <level>]
 *
 * `--init <file>` runs the file's lines, meta-commands and command blocks
 * alike, before the first interactive prompt, sharing the state the prompt
 * then continues from.
 *
 * `--format-module` is repeatable: each occurrence names one module to
 * dynamically `import()` and register, in the order given, so a later one can
 * knowingly override an earlier one's name.
 *
 * `--log-file <path>` logs to a file instead of this REPL's own stderr, and
 * `--log-level <level>` sets the starting verbosity (`debug`, `info`, `warn`
 * or `error`; default `warn`). The level can also be changed while running,
 * with the `log-level` meta-command.
 */

import { isLogLevel } from "@scfloworg/core";
import type { LogLevel } from "@scfloworg/core";

/** The parsed command line. */
export interface CliArgs {
  initFile?: string;
  /** Module specifiers to dynamically import and register, in the order given. */
  formatModules: string[];
  /** Logs to this file instead of stderr when given. */
  logFile?: string;
  logLevel: LogLevel;
  help?: boolean;
}

/**
 * Parses the arguments that follow the script name.
 *
 * @param argv - the raw arguments, such as `process.argv.slice(2)`.
 * @returns the parsed arguments; `help` is set for `--help` or `-h`.
 * @throws `Error` for an unknown argument, a flag missing its value, a second
 * `--init`, or a `--log-level` that is not one of the four levels.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { formatModules: [], logLevel: "warn" };
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];

    if (token === "--help" || token === "-h") {
      args.help = true;
      i += 1;
      continue;
    }

    if (token === "--init") {
      if (args.initFile) throw new Error("--init may only be given once");
      const file = argv[i + 1];
      if (!file || file.startsWith("--")) throw new Error("--init requires <file>");
      args.initFile = file;
      i += 2;
      continue;
    }

    if (token === "--format-module") {
      const specifier = argv[i + 1];
      if (!specifier || specifier.startsWith("--")) throw new Error("--format-module requires <specifier>");
      args.formatModules.push(specifier);
      i += 2;
      continue;
    }

    if (token === "--log-file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--log-file requires <path>");
      args.logFile = value;
      i += 2;
      continue;
    }

    if (token === "--log-level") {
      const value = argv[i + 1];
      if (!value || !isLogLevel(value)) throw new Error("--log-level requires one of debug, info, warn, error");
      args.logLevel = value;
      i += 2;
      continue;
    }

    throw new Error(`unknown argument "${token}"`);
  }

  return args;
}

/** The lines of the `--help` text. */
export function cliHelpLines(): string[] {
  return [
    "Usage: model-repl [--init <file>] [--format-module <specifier>]... [--log-file <path>] [--log-level <level>]",
    "",
    "  --init <file>               run <file>'s lines (meta-commands and command blocks, exactly as typed",
    "                               interactively — e.g. \"new js:mydb db1\", then \"run\" + a YAML block) before",
    "                               the first interactive prompt; the same dataset contexts, current dataset,",
    "                               and result/snippet variables it leaves behind are still there once the",
    "                               prompt starts",
    "  --format-module <specifier> import <specifier> and register the persistent format it exports; repeatable",
    "  --log-file <path>           log to <path> instead of this REPL's own stderr (see README.md's Logging);",
    "                               the level can still be changed at runtime, with the log-level meta-command",
    "  --log-level <level>         starting log level — debug, info, warn or error (default warn)",
    "  --help, -h                  show this help and exit",
  ];
}

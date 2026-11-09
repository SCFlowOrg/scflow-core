#!/usr/bin/env node
import { promises as fs } from "node:fs";
import * as readline from "node:readline";
import { createEngine } from "@scfloworg/core";
import type { Logger, PersistenceInterface } from "@scfloworg/core";
import { cliHelpLines, parseCliArgs } from "./cliArgs.js";
import type { LineSource, Output } from "./io.js";
import { createConsoleLogger, createFileLogger } from "./logging.js";
import { runRepl } from "./repl.js";
import { createReplState } from "./state.js";

function printBanner(out: Output): void {
  out.print("Model Command Language REPL");
  out.print("Type a command name — help for the list, help mcl for the command language,");
  out.print("run to enter a YAML command block.");
}

/** A `LineSource` over an already-read array of lines — used for `--init <file>`, see `loadInitLines` below. */
function arrayLineSource(lines: string[]): LineSource {
  let i = 0;
  return {
    async next() {
      return i < lines.length ? lines[i++] : null;
    },
  };
}

/**
 * Reads `file` and splits it into a `LineSource` of the same shape `runRepl`
 * reads from stdin — `--init <file>`'s whole mechanism is running this
 * through `runRepl` once, quietly, before the real interactive one starts
 * (see `main` below).
 * No special file format: it is read exactly the way a
 * transcript of typed input would be — meta-command lines, `run` + a YAML
 * block ending in a blank line, `snippet save <name>` + the block it
 * captures, and so on.
 */
async function loadInitLines(file: string): Promise<LineSource> {
  const text = await fs.readFile(file, "utf8");
  return arrayLineSource(text.split(/\r\n|\n/));
}

/**
 * Dynamically imports each `--format-module` specifier and registers the
 * `PersistenceInterface` it exports, in the order given. A module must export
 * it as a named `format`
 * export. Every persistent format goes through this, `js` included — the
 * CLI doesn't special-case any format by name. Registering a `name` already
 * taken by an earlier `--format-module` overwrites the earlier registration,
 * with a warning, the same pattern `registerOpenContext` already uses for
 * dataset names.
 */
async function loadFormatModules(specifiers: string[]): Promise<PersistenceInterface[]> {
  const registered = new Map<string, PersistenceInterface>();
  for (const specifier of specifiers) {
    let mod: unknown;
    try {
      mod = await import(specifier);
    } catch (err) {
      throw new Error(`--format-module "${specifier}": failed to import (${err instanceof Error ? err.message : String(err)})`);
    }
    const format = (mod as { format?: unknown }).format;
    if (!format || typeof format !== "object" || typeof (format as { name?: unknown }).name !== "string") {
      throw new Error(`--format-module "${specifier}": no "format" export shaped like a PersistenceInterface`);
    }
    const impl = format as PersistenceInterface;
    if (registered.has(impl.name)) {
      console.log(`warning: persistent format "${impl.name}" was already registered — overwritten by ${specifier}`);
    }
    registered.set(impl.name, impl);
  }
  return [...registered.values()];
}

async function main(): Promise<number> {
  let formats: PersistenceInterface[] = [];
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("");
    for (const line of cliHelpLines()) console.error(line);
    return 1;
  }

  if (args.help) {
    for (const line of cliHelpLines()) console.log(line);
    return 0;
  }

  try {
    formats = await loadFormatModules(args.formatModules);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // `--log-file` opts into a file sink; otherwise this REPL logs to its own
  // stderr (never stdout — that's the interactive prompt/output below).
  // See src/logging.ts.
  let logger: Logger;
  if (args.logFile !== undefined) {
    try {
      logger = await createFileLogger(args.logFile, args.logLevel);
    } catch (err) {
      console.error(`failed to open log file "${args.logFile}": ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  } else {
    logger = createConsoleLogger(args.logLevel);
  }

  const state = createReplState({ engine: createEngine({ formats }), logger });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const iterator = rl[Symbol.asyncIterator]();

  const lines: LineSource = {
    async next() {
      const { value, done } = await iterator.next();
      return done ? null : value;
    },
  };

  const out: Output = {
    print(text) {
      console.log(text);
    },
    printError(text) {
      console.error(text);
    },
    prompt(text) {
      rl.setPrompt(text);
      rl.prompt();
    },
  };

  printBanner(out);

  // `--init` runs its file's lines through the exact same `runRepl` loop,
  // sharing `state`, before the interactive one below starts — meta-commands
  // (`new`, `open`, `upload`, ...) and command blocks alike, exactly as if
  // they'd been typed there, one line at a time, ending each command block at
  // a blank line. A failed line doesn't abort this pass any more than it
  // would interactively; only a file that
  // can't even be read is fatal here.
  if (args.initFile) {
    let initLines: LineSource;
    try {
      initLines = await loadInitLines(args.initFile);
    } catch (err) {
      console.error(`--init "${args.initFile}": failed to read (${err instanceof Error ? err.message : String(err)})`);
      rl.close();
      return 1;
    }
    await runRepl(initLines, out, state);
  }

  await runRepl(lines, out, state);
  rl.close();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });

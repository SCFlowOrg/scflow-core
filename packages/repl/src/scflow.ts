/**
 * The `scflow` command: a project on disk, changed through actions (see
 * `docs/scflow.md`). Everything but the process itself is here, so tests run it.
 */

import type { AuthoredCommand } from "@scfloworg/core";
import type { Document } from "@scfloworg/workspace";
import { createProjectHost, type ProjectHost } from "@scfloworg/workspace/host";
import type { AiFetch } from "@scfloworg/ai";
import { ask, askSettings } from "./scflowAsk.js";

/** Where the command reads and writes. */
export interface ScflowIo {
  out(line: string): void;
  err(line: string): void;
  /** The lines of the standard input, read by `shell`. */
  lines: AsyncIterable<string>;
  /** The environment, read by `ask` for its connection; none when left out. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The `fetch` of `ask`; the global one when left out. */
  fetch?: AiFetch | undefined;
}

class UsageError extends Error {}

const USAGE = `usage:
  scflow <project> create --type <publisher:type> --title <title> --module <key>... [--modules <folder>]
  scflow <project> actions [--modules <folder>]
  scflow <project> run <action> [<parameters as JSON>] [--modules <folder>]
  scflow <project> query <schema> [<filters as JSON>] [--modules <folder>]
  scflow <project> shell [--modules <folder>]
  scflow <project> ask <prompt> [--yes] [--max-turns <n>] [--modules <folder>]`;

/** Options that take no value. */
const FLAGS = new Set(["yes"]);

interface ParsedArgs {
  positional: string[];
  options: Map<string, string[]>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (FLAGS.has(arg.slice(2))) {
      options.set(arg.slice(2), ["true"]);
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    options.set(arg.slice(2), [...(options.get(arg.slice(2)) ?? []), value]);
  }
  return { positional, options };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`not valid JSON: ${text}`);
  }
}

function required(parsed: ParsedArgs, name: string): string[] {
  const values = parsed.options.get(name);
  if (!values) throw new UsageError(`--${name} is required`);
  return values;
}

function describeActions(doc: Document): unknown[] {
  return doc.dataset.actions().map((action) => ({
    id: action.id,
    title: action.title,
    description: action.description,
    kind: action.kind,
    destructive: action.destructive,
    exposure: action.exposure,
  }));
}

async function runQuery(doc: Document, schema: string, filters: unknown): Promise<unknown[]> {
  const command = { query: schema, ...(filters === undefined ? {} : { filters }) } as unknown as AuthoredCommand;
  return (await doc.dataset.query(command)).after;
}

function printError(io: ScflowIo, error: unknown): void {
  const { code, message } = error as { code?: string; message?: string };
  io.err(JSON.stringify({ error: { code: code ?? "error", message: message ?? String(error) } }));
}

/** Runs the commands of the standard input. The changes stay in memory until `save`. */
async function shell(doc: Document, io: ScflowIo): Promise<void> {
  const print = (value: unknown) => io.out(JSON.stringify(value));
  let unsaved = false;

  const handle = async (line: string): Promise<boolean> => {
    const match = /^(\S+)(?:\s+(\S+))?(?:\s+(.*))?$/.exec(line.trim());
    if (!match) return true;
    const [, command, argument, rest] = match;
    switch (command) {
      case "run": {
        if (argument === undefined) throw new UsageError("run needs an action");
        const outcome = await doc.run(argument, parseJson(rest));
        unsaved ||= outcome.changed;
        print({ result: outcome.result, changed: outcome.changed });
        return true;
      }
      case "query":
        if (argument === undefined) throw new UsageError("query needs a schema");
        print(await runQuery(doc, argument, parseJson(rest)));
        return true;
      case "actions":
        print(describeActions(doc));
        return true;
      case "undo":
      case "redo": {
        const moved = await (command === "undo" ? doc.undo() : doc.redo());
        unsaved ||= moved;
        print({ [command]: moved });
        return true;
      }
      case "history":
        print(doc.history());
        return true;
      case "save":
        print({ written: (await doc.save()).written });
        unsaved = false;
        return true;
      case "exit":
        return false;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  };

  for await (const line of io.lines) {
    try {
      if (!(await handle(line))) break;
    } catch (error) {
      printError(io, error);
    }
  }
  if (unsaved) io.err("The changes are not saved.");
}

async function dispatch(args: string[], io: ScflowIo): Promise<void> {
  const parsed = parseArgs(args);
  const [project, command, first, second] = parsed.positional;
  if (project === undefined || command === undefined) throw new UsageError("a project and a command are needed");

  const host = (): Promise<ProjectHost> => createProjectHost({ modules: parsed.options.get("modules")?.at(-1) });
  const print = (value: unknown) => io.out(JSON.stringify(value));

  switch (command) {
    case "create": {
      const [type] = required(parsed, "type");
      const [title] = required(parsed, "title");
      const { workspace } = await host();
      const doc = await workspace.create({
        path: project,
        modules: required(parsed, "module"),
        type: type as string,
        title: title as string,
      });
      print({ written: (await doc.save()).written });
      return;
    }
    case "actions": {
      const doc = await (await host()).workspace.open(project, { readOnly: true });
      print(describeActions(doc));
      return;
    }
    case "query": {
      if (first === undefined) throw new UsageError("query needs a schema");
      const filters = parseJson(second);
      const doc = await (await host()).workspace.open(project, { readOnly: true });
      print(await runQuery(doc, first, filters));
      return;
    }
    case "run": {
      if (first === undefined) throw new UsageError("run needs an action");
      const params = parseJson(second);
      const doc = await (await host()).workspace.open(project);
      const outcome = await doc.run(first, params);
      const written = outcome.changed ? (await doc.save()).written : [];
      print({ result: outcome.result, changed: outcome.changed, written });
      return;
    }
    case "shell":
      await shell(await (await host()).workspace.open(project), io);
      return;
    case "ask": {
      if (first === undefined) throw new UsageError("ask needs a prompt");
      const settings = askSettings(io.env ?? {});
      if (typeof settings === "string") throw new UsageError(`ask needs ${settings} in the environment`);
      const turns = parsed.options.get("max-turns")?.at(-1);
      const maxTurns = turns === undefined ? 10 : Number(turns);
      if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new UsageError("--max-turns needs a positive integer");
      const lines = io.lines[Symbol.asyncIterator]();
      await ask(await (await host()).workspace.open(project), settings, {
        prompt: first,
        yes: parsed.options.has("yes"),
        maxTurns,
        fetch: io.fetch,
        out: io.out,
        err: io.err,
        readLine: async () => {
          const next = await lines.next();
          return next.done ? undefined : next.value;
        },
      });
      return;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/** Runs the command, and gives its exit code. */
export async function runScflow(args: string[], io: ScflowIo): Promise<number> {
  try {
    await dispatch(args, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    printError(io, error);
    return 1;
  }
}

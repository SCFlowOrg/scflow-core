/**
 * The `scflow` command: a project on disk, changed through actions (see
 * `docs/scflow.md`). Everything but the process itself is here, so tests run it.
 */

import { languagesOf, type AuthoredCommand } from "@scfloworg/core";
import type { Document } from "@scfloworg/workspace";
import { createProjectHost, type ProjectHost } from "@scfloworg/workspace/host";
import type { AiFetch } from "@scfloworg/ai";
import { ask, askSettings } from "./scflowAsk.js";
import { DOCS_COMMANDS, DocsUsageError, runDocs } from "./scflowDocs.js";
import { csvFilesOf, exportCsv, importCsv, type CsvOptions } from "./scflowSheets.js";

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
  scflow <project> create --type <publisher:type> --title <title> --module <key>... [--language <code>]... [--modules <folder>]
  scflow <project> languages [<codes as JSON array>] [--modules <folder>]
  scflow <project> actions [--modules <folder>]
  scflow <project> run <action> [<parameters as JSON>] [--modules <folder>]
  scflow <project> query <schema> [<filters as JSON>] [--modules <folder>]
  scflow <project> export <folder> [--schema <name>]... [--separator <c>] [--list-separator <s>] [--modules <folder>]
  scflow <project> import <folder|file.csv>... [--dry-run] [--separator <c>] [--list-separator <s>] [--modules <folder>]
  scflow <project> shell [--modules <folder>]
  scflow <project> ask <prompt> [--yes] [--max-turns <n>] [--modules <folder>]
  scflow docs list [--audience <audience>]... [--locale <code>] [--modules <folder>]
  scflow docs check [--modules <folder>]
  scflow docs build <directory> [--audience <audience>]... [--modules <folder>]
  scflow docs show <id> [--audience <audience>]... [--locale <code>] [--modules <folder>]`;

/** Options that take no value. */
const FLAGS = new Set(["yes", "dry-run"]);

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

/** The separators of the CSV files: the comma by default, one character that is not a quote or a line break. The text \t stands for a tab. */
function csvOptions(parsed: ParsedArgs): CsvOptions {
  const given = parsed.options.get("separator")?.at(-1);
  const separator = given === "\t" ? "\t" : (given ?? ",");
  if (separator.length !== 1 || separator === '"' || separator === "\n" || separator === "\r") {
    throw new UsageError("--separator needs one character, which is not a quote or a line break");
  }
  const listSeparator = parsed.options.get("list-separator")?.at(-1);
  if (listSeparator === "") throw new UsageError("--list-separator needs at least one character");
  return { separator, listSeparator };
}

/** `export <folder>`: the folder and the options, checked before the project is opened. */
function exportRequest(folders: string[], parsed: ParsedArgs) {
  const [folder, ...more] = folders;
  if (folder === undefined) throw new UsageError("export needs a folder");
  if (more.length > 0) throw new UsageError("export takes one folder");
  return { folder, options: { ...csvOptions(parsed), schemas: parsed.options.get("schema") ?? [] } };
}

/** `import <folder|file.csv>...`: the files and the options, checked before the project is opened. */
async function importRequest(inputs: string[], parsed: ParsedArgs) {
  if (inputs.length === 0) throw new UsageError("import needs a folder or a .csv file");
  const files = await csvFilesOf(inputs);
  if (files === undefined) throw new UsageError("a folder given to import holds no .csv file");
  return { files, options: { ...csvOptions(parsed), dryRun: parsed.options.has("dry-run") } };
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

/** The ordered languages of the document, `[]` when not stated. */
async function readLanguages(doc: Document): Promise<string[]> {
  return languagesOf((await doc.dataset.info()) as { languages?: unknown });
}

/** The list given to `languages`, an array of codes; the engine checks the codes and the duplicates. */
function parseLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) throw new UsageError("languages needs a JSON array of language codes, such as [\"fr\",\"en\"]");
  return value as string[];
}

async function runQuery(doc: Document, schema: string, filters: unknown): Promise<unknown[]> {
  const command = { query: schema, ...(filters === undefined ? {} : { filters }) } as unknown as AuthoredCommand;
  return (await doc.dataset.query(command)).after;
}

function printError(io: ScflowIo, error: unknown): void {
  const { code, message } = error as { code?: string; message?: string };
  io.err(JSON.stringify({ error: { code: code ?? "error", message: message ?? String(error) } }));
}

/** The words after the command of a line of the shell, as the positional arguments and the options. */
function shellArguments(line: string): [string[], ParsedArgs] {
  const parsed = parseArgs(line.trim().split(/\s+/).slice(1));
  return [parsed.positional, parsed];
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
      case "languages": {
        if (argument === undefined) {
          print({ languages: await readLanguages(doc) });
          return true;
        }
        const { changed } = await doc.setLanguages(parseLanguages(parseJson([argument, rest].filter((part) => part !== undefined).join(" "))));
        unsaved ||= changed;
        print({ languages: await readLanguages(doc), changed });
        return true;
      }
      case "export": {
        const { folder, options } = exportRequest(...shellArguments(line));
        print(await exportCsv(doc, folder, options));
        return true;
      }
      case "import": {
        const [inputs, parsed] = shellArguments(line);
        const { files, options } = await importRequest(inputs, parsed);
        const report = await importCsv(doc, files, options);
        unsaved ||= report.applied;
        print(report);
        return true;
      }
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

/** `scflow docs <command>`: no project, only the installed modules. Gives the exit code. */
async function docs(parsed: ParsedArgs, io: ScflowIo): Promise<number> {
  const [, command, argument] = parsed.positional;
  const { environment } = await createProjectHost({ modules: parsed.options.get("modules")?.at(-1) });
  try {
    const outcome = await runDocs(environment.docs, {
      command: command as (typeof DOCS_COMMANDS)[number],
      argument,
      audiences: parsed.options.get("audience") ?? [],
      locale: parsed.options.get("locale")?.at(-1),
    });
    for (const value of outcome.out) io.out(JSON.stringify(value));
    for (const line of outcome.err) io.err(line);
    return outcome.code;
  } catch (error) {
    if (error instanceof DocsUsageError) throw new UsageError(error.message);
    throw error;
  }
}

async function dispatch(args: string[], io: ScflowIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.positional[0] === "docs" && DOCS_COMMANDS.includes(parsed.positional[1] as (typeof DOCS_COMMANDS)[number])) {
    return docs(parsed, io);
  }
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
        ...(parsed.options.has("language") ? { languages: parsed.options.get("language") as string[] } : {}),
      });
      print({ written: (await doc.save()).written });
      return 0;
    }
    case "actions": {
      const doc = await (await host()).workspace.open(project, { readOnly: true });
      print(describeActions(doc));
      return 0;
    }
    case "languages": {
      if (first === undefined) {
        const doc = await (await host()).workspace.open(project, { readOnly: true });
        print({ languages: await readLanguages(doc) });
        return 0;
      }
      const languages = parseLanguages(parseJson(first));
      const doc = await (await host()).workspace.open(project);
      const { changed } = await doc.setLanguages(languages);
      const written = changed ? (await doc.save()).written : [];
      print({ languages: await readLanguages(doc), changed, written });
      return 0;
    }
    case "query": {
      if (first === undefined) throw new UsageError("query needs a schema");
      const filters = parseJson(second);
      const doc = await (await host()).workspace.open(project, { readOnly: true });
      print(await runQuery(doc, first, filters));
      return 0;
    }
    case "run": {
      if (first === undefined) throw new UsageError("run needs an action");
      const params = parseJson(second);
      const doc = await (await host()).workspace.open(project);
      const outcome = await doc.run(first, params);
      const written = outcome.changed ? (await doc.save()).written : [];
      print({ result: outcome.result, changed: outcome.changed, written });
      return 0;
    }
    case "export": {
      const { folder, options } = exportRequest(parsed.positional.slice(2), parsed);
      const doc = await (await host()).workspace.open(project, { readOnly: true });
      print(await exportCsv(doc, folder, options));
      return 0;
    }
    case "import": {
      const { files, options } = await importRequest(parsed.positional.slice(2), parsed);
      const doc = await (await host()).workspace.open(project);
      const report = await importCsv(doc, files, options);
      const written = report.applied ? (await doc.save()).written : [];
      print({ ...report, written });
      return report.ok ? 0 : 1;
    }
    case "shell":
      await shell(await (await host()).workspace.open(project), io);
      return 0;
    case "ask": {
      if (first === undefined) throw new UsageError("ask needs a prompt");
      const settings = askSettings(io.env ?? {});
      if (typeof settings === "string") throw new UsageError(`ask needs ${settings} in the environment`);
      const turns = parsed.options.get("max-turns")?.at(-1);
      const maxTurns = turns === undefined ? 10 : Number(turns);
      if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new UsageError("--max-turns needs a positive integer");
      const lines = io.lines[Symbol.asyncIterator]();
      const { environment, workspace } = await host();
      await ask(await workspace.open(project), settings, {
        prompt: first,
        skills: environment.skills,
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
      return 0;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/** Runs the command, and gives its exit code. */
export async function runScflow(args: string[], io: ScflowIo): Promise<number> {
  try {
    return await dispatch(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    printError(io, error);
    return 1;
  }
}

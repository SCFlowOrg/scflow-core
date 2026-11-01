import { promises as fs } from "node:fs";
import * as YAML from "js-yaml";
import { checkUpgrade, dumpDataset, isLogLevel, queryUpgradeLocator, substitutePlaceholders } from "@scfloworg/core";
import type { TransientValue } from "@scfloworg/core";
import { summarizeResult } from "./commandBlock.js";
import {
  commitUpgradeContext,
  createDatasetContext,
  createUpgradeContext,
  discardUpgradeContext,
  openDatasetContext,
  uploadDatasetContext,
} from "./datasets.js";
import { describeError } from "./errors.js";
import { currentContext } from "./state.js";
import type { DatasetContext, ReplState } from "./state.js";
import type { Output } from "./io.js";

/** `dumpDataset`/`restoreDataset`'s own format argument — not exported from `@scfloworg/core` (it's a local type in `api.ts`), so re-declared here. */
type DumpFormat = "json" | "yaml";

/** Parses `dump`/`upload`'s trailing `[json|yaml]` argument — defaults to `yaml` (the format every other REPL file output already uses: `print ... <file>`, `save <file>`). `undefined` on an invalid value, distinct from the (valid) default, so the caller can report a usage error instead of silently guessing. */
function parseDumpFormat(arg: string | undefined, out: Output): DumpFormat | undefined {
  if (arg === undefined) return "yaml";
  if (arg === "json" || arg === "yaml") return arg;
  out.printError(`unknown format "${arg}" — use json or yaml`);
  return undefined;
}

/**
 * Meta-commands. Every line is
 * dispatched here by default, no `:` prefix needed. `run` is the one command
 * whose outcome (`"awaitRunBlock"`) tells repl.ts to read the next block as
 * YAML and execute it instead; everything
 * else stays inside the meta-command surface.
 *
 * `snippet save <name>` is special the same way: it doesn't consume a value
 * itself, it asks the caller (repl.ts) to capture the *next* block verbatim
 * as the snippet's text, via the `{ awaitSnippetName }` outcome — the same
 * next-block mechanism `run` uses, just with a different destination.
 */
export type MetaOutcome = "exit" | "awaitRunBlock" | { awaitSnippetName: string } | undefined;

function requireCurrent(state: ReplState, out: Output): DatasetContext | null {
  const ctx = currentContext(state);
  if (!ctx) out.printError("no current dataset — open one with new or open, then use");
  return ctx;
}

/**
 * The current context, when it is an upgrade context — what `changes`,
 * `check`, `commit` and `discard` all need. An ordinary dataset gets a
 * message naming `upgrade` rather than a bare refusal, since that's the one
 * command that turns it into what they want.
 */
function requireUpgrade(state: ReplState, out: Output): (DatasetContext & { upgradeOf: string }) | null {
  const ctx = requireCurrent(state, out);
  if (!ctx) return null;
  if (ctx.upgradeOf === null) {
    out.printError(`"${ctx.name}" is an ordinary dataset — start a model change with upgrade first`);
    return null;
  }
  return ctx as DatasetContext & { upgradeOf: string };
}

/**
 * Splits a meta-command line into tokens on whitespace, with double quotes
 * grouping a token that holds spaces of its own — a vault path, a dataset
 * name, a file path. The quotes delimit, and are dropped from, the token they
 * surround. There is no escape character: a token containing a literal double
 * quote isn't expressible, which no locator, dataset name or file path here
 * needs to be.
 */
export function tokenizeMetaLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The `name` of every entry in one bucket of a model diff, for `changes`. */
function entryNames(entries: TransientValue[]): string {
  const names = entries.map((entry) => String((entry as Record<string, unknown>).name));
  return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * `print`/`copy` accept the same dot-path grammar as a `${...}` result
 * placeholder, just without the
 * `${}` wrapper — `r.after.0.name`, not `${r.after.0.name}`. Rather
 * than reimplementing path-walking, this wraps the path back into a
 * placeholder string and resolves it with the engine's own
 * `substitutePlaceholders`, against this dataset's variables. A bare name
 * (no dots) resolves the same way it always did — it's just a zero-segment
 * path. Throws the engine's own `unknown_reference` ModelError on a bad
 * path, which callers turn into a REPL error via `describeError`.
 */
function resolveVariablePath(ctx: DatasetContext, path: string): TransientValue {
  return substitutePlaceholders(`\${${path}}`, ctx.session.variables);
}

/**
 * Every meta-command name the switch below handles — kept as one list so
 * abbreviation resolution (just below) and the switch can't drift apart.
 * `show` and `quit` are separate entries even though they share a `case`
 * with `print`/`exit`: each is a name a user can type and abbreviate on its
 * own.
 */
const META_COMMAND_NAMES = [
  "run",
  "exit",
  "quit",
  "help",
  "new",
  "open",
  "upload",
  "use",
  "datasets",
  "upgrade",
  "changes",
  "check",
  "commit",
  "discard",
  "vars",
  "print",
  "show",
  "copy",
  "snippet",
  "save",
  "dump",
  "log-level",
] as const;

type CommandResolution = { kind: "exact" | "unique"; name: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "unknown" };

/**
 * Resolves a typed meta-command name against `META_COMMAND_NAMES`: exact
 * match wins outright; otherwise, if `typed` is a prefix of exactly one
 * name, that's the resolution (`h` -> `help`, `p` -> `print`); a prefix of
 * more than one name (`s` -> `save`/`show`/`snippet`) is ambiguous, not
 * guessed at.
 */
function resolveCommandName(typed: string): CommandResolution {
  if ((META_COMMAND_NAMES as readonly string[]).includes(typed)) {
    return { kind: "exact", name: typed };
  }
  const candidates = META_COMMAND_NAMES.filter((name) => name.startsWith(typed));
  if (candidates.length === 1) return { kind: "unique", name: candidates[0] };
  if (candidates.length === 0) return { kind: "unknown" };
  return { kind: "ambiguous", candidates: [...candidates].sort() };
}

function printHelp(out: Output): void {
  for (const line of [
    "run                              enter YAML input mode for one command block, then return here",
    "new <locator> <name>            create a dataset named <name> at <locator>, open it under that name",
    "open <locator>                   open an already-existing dataset, under its own stored name",
    "upload <locator> <file> [json|yaml]",
    "                                 create a dataset at <locator> from a dumpDataset snapshot in <file> (default yaml), open it under the dump's own dataset name",
    "use <name>                      switch the current dataset",
    "datasets                        list open datasets (* marks the current one, and what each upgrade belongs to)",
    "upgrade [<name>]                start a model change: create an upgrade locator for the current dataset",
    "                                 (or <name>), open it as its own context, and make it current",
    "changes                         list the schemas/scalar types this upgrade context has added, changed or lost",
    "check                           report how the source dataset's data would fare (autoUpdate/modifiedSchema/lostSchema)",
    "commit                          apply this upgrade to its source dataset, then close the upgrade context",
    "discard                         throw this upgrade away, then close the upgrade context",
    "vars                            list result variables in the current dataset",
    "print <name>[.path] [file]      show a variable's content, or a value inside it (e.g. r.after.0.name); write it to <file>",
    "                                 instead of stdout when given (reload later with snippet load). show also works",
    "copy <name>[.path] <to>         copy a variable, or a value inside it, to a new name (e.g. before it gets overwritten)",
    "snippet save <name>             capture the next block as $<name>",
    "snippet load <name> <file>      read $<name> from <file>",
    "snippet list                    list saved snippet names",
    "save <file>                     save commands run so far in this dataset as a replayable script",
    "dump <file> [json|yaml]         write the current dataset as a whole-dataset snapshot to <file> (default yaml) — restore it later with upload",
    "log-level <level>               change logging verbosity (debug/info/warn/error) without restarting — see README.md's Logging",
    "help [mcl]                      show this list, or a short Model Command Language cheat-sheet",
    "exit / quit                     leave the REPL",
    "",
    "A schema or scalar type is only ever created, changed or deleted inside an upgrade context —",
    "upgrade, then run blocks with schema: schema / schema: scalar_type, then commit.",
    "",
    "An argument holding spaces goes in double quotes: new \"I:/My Vault/00-VAULT_MODEL\" vault_model.",
    "open takes the whole rest of the line as its locator, so it needs no quotes.",
    "",
    "Any unambiguous prefix works: r for run, h for help, n for new, sh for show. Ambiguous alone:",
    "c (changes/check/commit/copy), d (datasets/discard/dump), s (save/show/snippet), u (upgrade/upload/use);",
    "type enough letters to disambiguate.",
    "",
    "Opening/creating a dataset under a name already in use in this session overwrites that entry",
    "(a warning is printed) — there's no separate alias to avoid the collision with.",
  ]) {
    out.print(line);
  }
}

function printMclHelp(out: Output): void {
  for (const line of [
    'Type "run", then a YAML block ending with a blank line:',
    "  kind: query | create | update | delete",
    "  schema: <schema name>",
    "  filters: {...}     # query/update/delete — property: value, or and/or/not",
    "  input: [...]       # create/update — an array of objects",
    "  as: <name>         # optional — names this command's result for a later ${...} reference",
    "",
    "Shorthand: query:/create:/update:/delete: <schema> instead of kind:+schema: — the key names",
    "the kind, its value names the schema (not both forms at once):",
    "  create: task",
    '  input: [{title: "Write the intro banner"}]',
    "",
    "A command prints a one-line summary (before/after/cascade-deleted/updated-before/updated-after",
    "counts) instead of the full result — the values live in $r (or your `as:` name); see",
    "print/show below to look at them.",
    "",
    "Result variables (available once a command has run):",
    "  ${r.after.0.id}        the previous command's result — always set, no `as` needed",
    "  ${myname.after.0.id}   a command run with `as: myname`",
    "  ${r.after.id}          an omitted array index defaults to 0 — same as .after.0.id",
    "  ${r.after.*.id}        * maps the rest of the path over every entry instead — an array of every id",
    "",
    "YAML snippets — a bare $name is spliced in as raw text before parsing (see snippet):",
    "  $active_tasks",
    "",
    "Example — run, then create, then look the new row up by the id it was given:",
    "  run",
    "  kind: create",
    "  schema: task",
    "  as: t1",
    '  input: [{title: "Write the intro banner"}]',
    "",
    "  run",
    "  kind: query",
    "  schema: task",
    '  filters: {id: "${t1.after.0.id}"}',
  ]) {
    out.print(line);
  }
}

/**
 * Dispatches one meta-command line. The command name may be any unambiguous
 * prefix of a name; the arguments are split by `tokenizeMetaLine`. A usage
 * error or a failure is printed with `out.printError` and never thrown.
 *
 * @returns `"exit"` for `exit` and `quit`; `"awaitRunBlock"` for `run`;
 * `{ awaitSnippetName }` for `snippet save <name>`; `undefined` otherwise.
 */
export async function handleMeta(state: ReplState, line: string, out: Output): Promise<MetaOutcome> {
  const tokens = tokenizeMetaLine(line);
  const [typed, ...args] = tokens;

  if (!typed) {
    printHelp(out);
    return undefined;
  }

  const resolution = resolveCommandName(typed);
  if (resolution.kind === "unknown") {
    out.printError(`unknown command "${typed}" — try help`);
    return undefined;
  }
  if (resolution.kind === "ambiguous") {
    out.printError(`"${typed}" is ambiguous — matches ${resolution.candidates.join(", ")}`);
    return undefined;
  }
  const cmd = resolution.name;

  // Logged once, generically, for every meta-command — the REPL's
  // counterpart to packages/mcp/src/server.ts's per-tool `debug` log. Never
  // routed through `out`: the logger is a diagnostic channel (stderr or a
  // file, see src/logging.ts), not the interactive one, so this can't
  // change what a session sees on screen.
  state.logger.log("debug", `meta-command: ${cmd}`, args.length > 0 ? { args } : undefined);

  switch (cmd) {
    case "run":
      return "awaitRunBlock";

    case "exit":
    case "quit":
      return "exit";

    case "help":
      if (args[0] === "mcl") printMclHelp(out);
      else printHelp(out);
      return undefined;

    case "new": {
      const [locator, name] = args;
      if (!locator || !name) {
        out.printError("usage: new <locator> <name>");
        return undefined;
      }
      try {
        const { ctx, overwrote } = await createDatasetContext(state, locator, name);
        if (overwrote) out.print(`warning: "${ctx.name}" was already open — overwritten`);
        const marker = state.currentName === ctx.name ? " (current)" : "";
        out.print(`created "${ctx.name}" -> ${locator}${marker}`);
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "open": {
      // A locator can hold spaces — a vault path like "I:\Shared drives\..."
      // — so the whole rest of the line is the locator. Quote it instead when
      // a command takes further arguments after one, as `new` does.
      const locator = args.join(" ");
      if (!locator) {
        out.printError("usage: open <locator>");
        return undefined;
      }
      try {
        const { ctx, overwrote } = await openDatasetContext(state, locator);
        if (overwrote) out.print(`warning: "${ctx.name}" was already open — overwritten`);
        const marker = state.currentName === ctx.name ? " (current)" : "";
        out.print(`opened "${ctx.name}" -> ${locator}${marker}`);
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "upload": {
      const [locator, file, formatArg] = args;
      if (!locator || !file) {
        out.printError("usage: upload <locator> <file> [json|yaml]");
        return undefined;
      }
      const format = parseDumpFormat(formatArg, out);
      if (!format) return undefined;
      try {
        const dump = await fs.readFile(file, "utf8");
        const { ctx, result, overwrote } = await uploadDatasetContext(state, locator, dump, format);
        if (overwrote) out.print(`warning: "${ctx.name}" was already open — overwritten`);
        const marker = state.currentName === ctx.name ? " (current)" : "";
        out.print(`uploaded "${ctx.name}" -> ${locator} from ${file}${marker}`);
        if (result.pendingRealignment.length > 0) {
          out.print(`pending realignment: ${result.pendingRealignment.length} import(s) need refreshImport once Import is implemented`);
        }
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "use": {
      // A dataset name can contain spaces — every upgrade context is called
      // "<source name> (upgrade)" — so the whole rest of the line is the
      // name, not just the next token.
      const name = args.join(" ");
      if (!name) {
        out.printError("usage: use <name>");
        return undefined;
      }
      if (!state.contexts.has(name)) {
        out.printError(`unknown dataset "${name}" (see datasets)`);
        return undefined;
      }
      state.currentName = name;
      out.print(`current dataset: ${name}`);
      return undefined;
    }

    case "datasets": {
      if (state.contexts.size === 0) {
        out.print("(no datasets open)");
        return undefined;
      }
      for (const ctx of state.contexts.values()) {
        const role = ctx.upgradeOf === null ? "" : `  (upgrade of ${ctx.upgradeOf})`;
        out.print(`${ctx.name === state.currentName ? "*" : " "} ${ctx.name}  ${ctx.locator}${role}`);
      }
      return undefined;
    }

    case "upgrade": {
      const name = args.join(" "); // a dataset name can contain spaces — see `use` below
      const target = name ? state.contexts.get(name) : currentContext(state);
      if (!target) {
        out.printError(name ? `unknown dataset "${name}" (see datasets)` : "no current dataset — open one with new or open, then use");
        return undefined;
      }
      if (target.upgradeOf !== null) {
        out.printError(`"${target.name}" is already an upgrade of ${target.upgradeOf} — commit or discard it first`);
        return undefined;
      }
      try {
        const { ctx, overwrote } = await createUpgradeContext(state, target.locator);
        if (overwrote) out.print(`warning: "${ctx.name}" was already open — overwritten`);
        state.currentName = ctx.name;
        out.print(`upgrading "${target.name}" in "${ctx.name}" -> ${ctx.locator} (current)`);
        out.print("run schema/scalar_type commands here, then commit — or discard to throw them away");
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "changes": {
      const ctx = requireUpgrade(state, out);
      if (!ctx) return undefined;
      try {
        const { commandResult } = await queryUpgradeLocator(ctx.locator);
        out.print(`before:          ${entryNames(commandResult.before)}`);
        out.print(`after:           ${entryNames(commandResult.after)}`);
        out.print(`cascade-deleted: ${entryNames(commandResult["cascade-deleted"])}`);
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "check": {
      const ctx = requireUpgrade(state, out);
      if (!ctx) return undefined;
      try {
        const result = await checkUpgrade(ctx.upgradeOf, ctx.locator);
        out.print(`autoUpdate: ${result.autoUpdate.length}  modifiedSchema: ${result.modifiedSchema.length}  lostSchema: ${result.lostSchema.length}`);
        if (result.modifiedSchema.length > 0 || result.lostSchema.length > 0) {
          out.print("commit rejects this as incompatible_upgrade — resolve those instances outside the modelling language first");
        }
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "commit": {
      const ctx = requireUpgrade(state, out);
      if (!ctx) return undefined;
      try {
        const { result, sourceLocator } = await commitUpgradeContext(state, ctx);
        out.print(`committed "${ctx.name}" -> ${sourceLocator}`);
        out.print(summarizeResult(result));
        const now = currentContext(state);
        out.print(now ? `current dataset: ${now.name}` : "(no datasets open)");
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "discard": {
      const ctx = requireUpgrade(state, out);
      if (!ctx) return undefined;
      try {
        await discardUpgradeContext(state, ctx);
        out.print(`discarded "${ctx.name}"`);
        const now = currentContext(state);
        out.print(now ? `current dataset: ${now.name}` : "(no datasets open)");
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "vars": {
      const ctx = requireCurrent(state, out);
      if (!ctx) return undefined;
      const names = Object.keys(ctx.session.variables);
      if (names.length === 0) out.print("(no variables yet — every command sets $r once one runs)");
      else for (const name of names) out.print(name);
      return undefined;
    }

    case "print":
    case "show": {
      const [path, file] = args;
      const ctx = requireCurrent(state, out);
      if (!ctx) return undefined;
      if (!path) {
        out.printError(`usage: ${cmd} <name>[.path...] [file]`);
        return undefined;
      }
      try {
        const value = resolveVariablePath(ctx, path);
        const dumped = YAML.dump(value, { noRefs: true, lineWidth: -1 });
        if (file) {
          await fs.writeFile(file, dumped, "utf8");
          out.print(`saved ${path} to ${file}`);
        } else {
          out.print(dumped.trimEnd());
        }
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "copy": {
      const [path, to] = args;
      const ctx = requireCurrent(state, out);
      if (!ctx) return undefined;
      if (!path || !to) {
        out.printError("usage: copy <name>[.path...] <to>");
        return undefined;
      }
      try {
        const value = resolveVariablePath(ctx, path);
        ctx.session.variables[to] = value;
        out.print(`copied ${path} -> ${to}`);
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "snippet": {
      const [sub, name, file] = args;
      if (sub === "save") {
        if (!name) {
          out.printError("usage: snippet save <name>");
          return undefined;
        }
        return { awaitSnippetName: name };
      }
      if (sub === "load") {
        if (!name || !file) {
          out.printError("usage: snippet load <name> <file>");
          return undefined;
        }
        try {
          const text = await fs.readFile(file, "utf8");
          state.snippets.set(name, text.replace(/\r?\n$/, ""));
          out.print(`loaded as $${name}`);
        } catch (err) {
          out.printError(describeError(err));
        }
        return undefined;
      }
      if (sub === "list") {
        const names = [...state.snippets.keys()];
        if (names.length === 0) out.print("(no snippets saved)");
        else for (const n of names) out.print(n);
        return undefined;
      }
      out.printError("usage: snippet save <name> | snippet load <name> <file> | snippet list");
      return undefined;
    }

    case "save": {
      const [file] = args;
      const ctx = requireCurrent(state, out);
      if (!ctx) return undefined;
      if (!file) {
        out.printError("usage: save <file>");
        return undefined;
      }
      try {
        await fs.writeFile(file, YAML.dump({ commands: ctx.history }, { noRefs: true, lineWidth: -1 }), "utf8");
        out.print(`saved ${ctx.history.length} command(s) to ${file}`);
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "dump": {
      const [file, formatArg] = args;
      const ctx = requireCurrent(state, out);
      if (!ctx) return undefined;
      if (!file) {
        out.printError("usage: dump <file> [json|yaml]");
        return undefined;
      }
      const format = parseDumpFormat(formatArg, out);
      if (!format) return undefined;
      try {
        const text = await dumpDataset(ctx.locator, format);
        await fs.writeFile(file, text, "utf8");
        out.print(`dumped "${ctx.name}" -> ${file} (${format})`);
      } catch (err) {
        out.printError(describeError(err));
      }
      return undefined;
    }

    case "log-level": {
      const [level] = args;
      if (!level || !isLogLevel(level)) {
        out.printError("usage: log-level <debug|info|warn|error>");
        return undefined;
      }
      state.logger.level = level;
      out.print(`log level: ${level}`);
      return undefined;
    }

    default:
      // Unreachable: resolveCommandName only ever returns a name from
      // META_COMMAND_NAMES, and every entry there has a case above.
      out.printError(`unknown command "${cmd}" — try help`);
      return undefined;
  }
}

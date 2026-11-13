import * as YAML from "js-yaml";
import { resolveCommandForm } from "@scfloworg/core";
import type { CommandResult, Filter, ScriptCommand, TransientValue } from "@scfloworg/core";
import { describeError } from "./errors.js";
import { expandSnippets } from "./snippets.js";
import { currentContext } from "./state.js";
import type { ReplState } from "./state.js";
import type { Output } from "./io.js";

/**
 * Parses and runs one typed YAML block against the current dataset context:
 * the REPL's counterpart to a single `script_command` of a script.
 */

const COMMAND_KINDS = new Set(["query", "create", "update", "delete"]);

const RESULT_KEYS = ["before", "after", "cascade-deleted", "updated-before", "updated-after"] as const;

/**
 * A one-line entry-count summary of a `CommandResult`, printed instead of the
 * full dump so a run of commands does not scroll the actual values off screen.
 * The values are not hidden: `r` and the `as` names still hold the full
 * result, reachable with `print` or `show` (a whole variable, or a path into
 * it) or a later `${...}` placeholder.
 */
export function summarizeResult(result: CommandResult): string {
  return RESULT_KEYS.map((key) => `${key}: ${result[key].length}`).join("  ");
}

function toScriptCommand(parsed: unknown, out: Output): ScriptCommand | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    out.printError('a command must be a YAML mapping — "kind"+"schema", or one of query:/create:/update:/delete:');
    return null;
  }

  // Resolves the authored form (`query:`, `create:`, `update:` or `delete:` as
  // a top-level key naming the schema) to canonical `kind` and `schema`, the
  // same normalization `@scfloworg/core` applies internally, so a bad
  // `kind`/sugar combination is reported before the block reaches the engine.
  let obj: Record<string, unknown>;
  try {
    obj = resolveCommandForm(parsed);
  } catch (err) {
    out.printError(describeError(err));
    return null;
  }

  if (typeof obj.kind !== "string" || !COMMAND_KINDS.has(obj.kind)) {
    out.printError(`"kind" must be one of query, create, update, delete (got ${JSON.stringify(obj.kind)})`);
    return null;
  }
  if (typeof obj.schema !== "string") {
    out.printError('"schema" is required and must be a string');
    return null;
  }

  const scriptCommand: ScriptCommand = { kind: obj.kind as ScriptCommand["kind"], schema: obj.schema };

  if (obj.filters !== undefined) {
    if (typeof obj.filters !== "object" || obj.filters === null || Array.isArray(obj.filters)) {
      out.printError('"filters" must be a mapping');
      return null;
    }
    scriptCommand.filters = obj.filters as Filter;
  }
  if (obj.input !== undefined) {
    if (!Array.isArray(obj.input)) {
      out.printError('"input" must be an array');
      return null;
    }
    scriptCommand.input = obj.input as TransientValue[];
  }
  if (obj.as !== undefined) {
    if (typeof obj.as !== "string") {
      out.printError('"as" must be a string');
      return null;
    }
    scriptCommand.as = obj.as;
  }

  return scriptCommand;
}

/**
 * Expands the snippets of `blockText`, parses it as one YAML command, runs it
 * on the current dataset context and prints `summarizeResult` of the result.
 * The result is stored in the variable `r`, and in the `as` name when the
 * command carries one. A blank block does nothing. Every failure (no current
 * dataset, unknown snippet, YAML error, invalid command, engine error) is
 * printed with `out.printError` and never thrown.
 */
export async function runCommandBlock(state: ReplState, blockText: string, out: Output): Promise<void> {
  if (blockText.trim() === "") return;

  const ctx = currentContext(state);
  if (!ctx) {
    out.printError("no current dataset — open one with new or open, then use");
    return;
  }

  let expanded: string;
  try {
    expanded = expandSnippets(blockText, state.snippets);
  } catch (err) {
    out.printError(describeError(err));
    return;
  }

  let parsed: unknown;
  try {
    parsed = YAML.load(expanded);
  } catch (err) {
    out.printError(`YAML parse error — ${describeError(err)}`);
    return;
  }

  const scriptCommand = toScriptCommand(parsed, out);
  if (!scriptCommand) return;

  try {
    const result = await ctx.session.run(scriptCommand);
    ctx.history.push(scriptCommand);
    // Every command also names its result "r", on top of any explicit `as`,
    // so `${r.after.0...}` always means the previous command's result in this
    // dataset context. `session.variables` is the same object the engine reads
    // its placeholder context from on the next `run()` call, so mutating it
    // here is enough (`readonly` only blocks reassigning the property).
    ctx.session.variables.r = result as unknown as TransientValue;
    const summary = summarizeResult(result);
    // The logger is a diagnostic channel (stderr or a file, never stdout), so
    // logging here cannot change what a session sees on screen.
    state.logger.log("info", "command executed", {
      dataset: ctx.name,
      kind: scriptCommand.kind,
      schema: scriptCommand.schema,
      summary,
    });
    out.print(summary);
  } catch (err) {
    state.logger.log("error", "command failed", {
      dataset: ctx.name,
      kind: scriptCommand.kind,
      schema: scriptCommand.schema,
      error: describeError(err),
    });
    out.printError(describeError(err));
  }
}

import { modelError } from "./errors.js";
import { runCommand } from "./command.js";
import { isModelSchema } from "./modelUpgrade.js";
import { substitutePlaceholders } from "./placeholders.js";
import type { ResolversLookup } from "./resolvers.js";
import type { Command, CommandResult, Filter, PersistenceInterface, Script, ScriptCommand, TransientValue } from "./types.js";

/**
 * Script processing, per packages/core/docs/spec/model-command-language.md#script.
 *
 * The named-results context a script builds up as it runs (`namedResults` in
 * packages/core/docs/spec/model-command-language.md#script's "Chaining" section) is factored out
 * into `createScriptSession` below, so it can outlive a single `runScript`
 * call. `runScript` is a thin loop over one session, for a complete `Script`
 * run start-to-finish in one call. `@scfloworg/repl` uses the same session
 * directly instead, keeping it alive across many separately-typed commands —
 * see packages/repl/docs/commands.md.
 *
 * `createScriptSession`/`run` take a `getResolvers: ResolversLookup` rather
 * than a resolved `Resolvers` value — a deferred, re-callable way to get the
 * locator's `Resolvers`, called once per `run()`. This keeps the caching
 * policy entirely out of script.ts: api.ts's plain `createScriptSession`
 * loads once and hands back a lookup that just returns that same value every
 * time (see api.ts), while `ApiSession.createScriptSession`
 * (see `docs/sessions.md`) hands
 * back a lookup backed by its own per-locator cache — shared with, and
 * reused by, every other call the same `ApiSession` makes against that
 * locator, including a second `ScriptSession` opened against it later.
 */

/**
 * Runs commands one at a time on one dataset, keeping the named results of
 * earlier commands in `variables` for the placeholders of later ones.
 * `runScript` is a loop over one session; `@scfloworg/repl` keeps one open
 * across separately typed commands.
 */
export interface ScriptSession {
  /** Named results so far, keyed by each step's `as`. */
  readonly variables: Record<string, TransientValue>;
  /** Resolve placeholders in `scriptCommand` against `variables` (+ `dataset`), run it, record `as` if given. */
  run(scriptCommand: ScriptCommand): Promise<CommandResult>;
}

/**
 * Opens a script session against `rest`: fetches the dataset's transient
 * value once (used for `${dataset...}` placeholders throughout the session,
 * exactly as a single `runScript` call already did), and returns a `run`
 * function that can be called any number of times, threading `variables`
 * through each call the way a `Script`'s steps do within one array.
 */
export async function createScriptSession(
  impl: PersistenceInterface,
  rest: string,
  getResolvers: ResolversLookup,
): Promise<ScriptSession> {
  const datasetValue = await impl.getDataset(rest);
  const namedResults: Record<string, TransientValue> = {};

  return {
    variables: namedResults,
    async run(scriptCommand: ScriptCommand): Promise<CommandResult> {
      const context: Record<string, TransientValue> = { dataset: datasetValue, ...namedResults };
      const command: Command = {
        kind: scriptCommand.kind,
        schema: scriptCommand.schema,
        // A `${this...}` operand is a path on the instance being tested, resolved
        // per instance by the filter (see Filter, *Paths on the right*): left as is.
        filters: scriptCommand.filters
          ? (substituteKeepingThis(scriptCommand.filters as unknown as TransientValue, context) as unknown as Filter)
          : undefined,
        // A `schema`/`scalar_type` command's input is a description, and a
        // `${...}` in one of its `default_value`s belongs to the instances
        // that schema will later construct — packages/core/docs/spec/model-command-language.md#schema-processing's
        // "Out of scope: placeholders" leaves it a literal string all the way
        // into storage, and packages/core/docs/spec/meta-model.md#placeholders resolves
        // it at construction time, against a `this` that exists only then.
        // Resolving it here would consume it against the script's own context
        // instead, where `this` is absent. Filters carry no such payload and
        // are substituted either way.
        // A non-array `input` is malformed (types.ts says `TransientValue[]`)
        // but the MCP boundary doesn't enforce it — mapping over it here
        // would throw a raw, untyped TypeError before runCommand ever sees
        // it. Passing it through unchanged instead lets runCommand's own
        // guard reject it with the same constraint_violation a direct
        // run_command call gets.
        input: scriptCommand.input
          ? isModelSchema(scriptCommand.schema) || !Array.isArray(scriptCommand.input)
            ? scriptCommand.input
            : scriptCommand.input.map((item) => substitutePlaceholders(item, context))
          : undefined,
        // Carried through as authored. `script_command` extends `command`, so
        // a step is shaped exactly as a standalone command is
        // (packages/core/docs/spec/model-command-language.md#command's "Result shaping") — including
        // the result a step names with `as`, which is then what the following
        // steps' placeholders can reach. No substitution: `result` holds
        // property names and a flag, never a value read off an earlier step.
        result: scriptCommand.result,
      };

      const resolvers = await getResolvers();
      const result = await runCommand(impl, rest, command, resolvers);
      if (scriptCommand.as) {
        namedResults[scriptCommand.as] = result as unknown as TransientValue;
      }
      return result;
    },
  };
}

/** `substitutePlaceholders`, leaving every string that names a path on `this` as it is. */
function substituteKeepingThis(value: TransientValue, context: Record<string, TransientValue>): TransientValue {
  if (typeof value === "string") return /\$\{\s*this[.}\s]/.test(value) ? value : substitutePlaceholders(value, context);
  if (Array.isArray(value)) return value.map((v) => substituteKeepingThis(v, context));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteKeepingThis(v, context)]));
  }
  return value;
}

export async function runScript(
  impl: PersistenceInterface,
  rest: string,
  script: Script,
  getResolvers: ResolversLookup,
): Promise<CommandResult> {
  if (!script.commands || script.commands.length === 0) {
    throw modelError("constraint_violation", "a script requires at least one command");
  }

  const session = await createScriptSession(impl, rest, getResolvers);
  let lastResult: CommandResult | null = null;
  for (const scriptCommand of script.commands) {
    lastResult = await session.run(scriptCommand);
  }

  return lastResult as CommandResult;
}

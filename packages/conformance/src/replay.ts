import type { ActionImplementation, ConformanceRegistry, ConformanceRunHost } from "./actions.js";

/**
 * The replay of a body against its run entry, the third level of the contract
 * of a body (`packages/core/docs/spec/meta-model.md`, section Action): the body
 * runs with the recorded parameters, each command receives its recorded result,
 * and the body must emit the same steps and end the same way. Nothing here
 * needs a dataset or an engine.
 */

/** One call of an action, as the run log holds it (`run_entry` of the specification). */
export interface ReplayEntry {
  readonly action: string;
  readonly parameters: string;
  readonly steps: readonly ReplayStep[];
  readonly outcome: "done" | "refused";
  readonly error?: string;
  readonly result?: string;
}

/** One effect of a body (`run_step`): a command with its result, or a call. */
export type ReplayStep =
  { readonly command: unknown; readonly result: string } | { readonly call: ReplayEntry };

/** What a replayed body emits through, one step at a time. */
export interface ReplayContext {
  /** Checks a command against the next step, and resolves to its recorded result. */
  command(command: unknown): Promise<unknown>;
  /** Checks a call against the next step, and replays the called body against its entry. */
  call(id: string, params?: unknown): Promise<unknown>;
}

/** The first place where a replay left its entry. */
export interface ReplayMismatch {
  /** Where, for example `steps[2].call.steps[0]`, or `result`. */
  readonly path: string;
  /** What the entry holds there, in canonical JSON; absent when it holds nothing. */
  readonly expected?: string;
  /** What the replay gave there, in canonical JSON; absent when it gave nothing. */
  readonly actual?: string;
}

export type ReplayReport =
  { readonly matches: true } | { readonly matches: false; readonly mismatch: ReplayMismatch };

export interface ReplayOptions {
  /**
   * Builds the context the body receives from the emitters of the replay, for a
   * body written against the context of its host. Absent, the body receives the
   * `ReplayContext` itself.
   */
  context?(replay: ReplayContext): unknown;
}

/** A call refused by its parameters ran no body: its replay must refuse it the same way. */
function refusedByParameters(entry: ReplayEntry): boolean {
  return entry.outcome === "refused" && entry.error === "invalid_parameters" && entry.steps.length === 0;
}

/**
 * Replays the body of `entry`, found in `registry` by its action, and tells
 * whether it emits the same steps and ends with the same outcome, error and
 * result, compared in canonical JSON. A nested call is replayed against the
 * entry of its step. The body emits one step at a time, in order, as its
 * contract says; a `ref` value stands for itself, since an entry holds keys.
 *
 * Rejects with `unknown_action` when the registry does not have the action of
 * `entry`. A body that breaks its contract does not reject: the report gives
 * the first mismatch.
 */
export async function replayEntry(
  impl: Pick<ActionImplementation, "canonicalJson">,
  registry: ConformanceRegistry,
  entry: ReplayEntry,
  options: ReplayOptions = {},
): Promise<ReplayReport> {
  const canonical = impl.canonicalJson;
  let first: ReplayMismatch | undefined;
  let replayed: ReplayEntry | undefined;
  /** The entry and the path of the next body to run; set before each call, read when it starts. */
  let next = { entry, path: "" };

  function mismatch(found: ReplayMismatch): Error {
    first ??= found;
    return new Error(`replay: the body left its entry at ${found.path}`);
  }

  const host: ConformanceRunHost = {
    resolveRef: (_schema, value) => ({
      id: refusedByParameters(next.entry) ? null : value,
      names: [],
    }),
    context(trace) {
      const { entry: expected, path } = next;
      let position = 0;
      const nextStep = () => {
        const at = `${path}steps[${position}]`;
        const step = expected.steps[position];
        position += 1;
        return {
          at,
          step,
          text: step === undefined ? undefined : canonical(step),
        };
      };
      const replay: ReplayContext = {
        async command(command) {
          const { at, step, text } = nextStep();
          if (
            step === undefined ||
            !("command" in step) ||
            canonical(step.command) !== canonical(command)
          ) {
            throw mismatch({ path: at, expected: text, actual: canonical({ command }) });
          }
          const result: unknown = JSON.parse(step.result);
          trace.command(command, result);
          return result;
        },
        async call(id, params) {
          const { at, step, text } = nextStep();
          if (step === undefined || !("call" in step) || step.call.action !== id) {
            throw mismatch({
              path: at,
              expected: text,
              actual: canonical({ call: { action: id, parameters: params ?? {} } }),
            });
          }
          next = { entry: step.call, path: `${at}.call.` };
          return trace.call(id, params);
        },
      };
      return options.context ? options.context(replay) : replay;
    },
    onEntry(recorded) {
      replayed = recorded as ReplayEntry;
    },
  };

  try {
    await registry.run(entry.action, JSON.parse(entry.parameters), host);
  } catch (error) {
    if (replayed === undefined) throw error;
  }
  const found = first ?? firstDifference(canonical, entry, replayed as ReplayEntry, "");
  return found ? { matches: false, mismatch: found } : { matches: true };
}

/** The first place where two entries differ, in canonical JSON; `undefined` when they do not. */
function firstDifference(
  canonical: (value: unknown) => string,
  expected: ReplayEntry,
  actual: ReplayEntry,
  path: string,
): ReplayMismatch | undefined {
  const field = (name: "action" | "parameters"): ReplayMismatch | undefined =>
    expected[name] === actual[name]
      ? undefined
      : { path: `${path}${name}`, expected: expected[name], actual: actual[name] };
  const before = field("action") ?? field("parameters");
  if (before) return before;

  const steps = Math.max(expected.steps.length, actual.steps.length);
  for (let index = 0; index < steps; index += 1) {
    const at = `${path}steps[${index}]`;
    const left = expected.steps[index];
    const right = actual.steps[index];
    if (left !== undefined && right !== undefined && "call" in left && "call" in right) {
      const nested = firstDifference(canonical, left.call, right.call, `${at}.call.`);
      if (nested) return nested;
      continue;
    }
    const expectedText = left === undefined ? undefined : canonical(left);
    const actualText = right === undefined ? undefined : canonical(right);
    if (expectedText !== actualText) return { path: at, expected: expectedText, actual: actualText };
  }

  for (const name of ["outcome", "error", "result"] as const) {
    if (expected[name] !== actual[name]) {
      return { path: `${path}${name}`, expected: expected[name], actual: actual[name] };
    }
  }
  return undefined;
}

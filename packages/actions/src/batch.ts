import { actionError } from "./errors.js";
import { canonicalJson } from "./json.js";
import type { ActionRegistry } from "./registry.js";
import type { RunEntry, RunHost, RunTrace } from "./types.js";

/**
 * A step of a batch run by this package: a call of an action by id, with its
 * parameters in `with`, its result named by `as`.
 */
export interface BatchCall {
  readonly call: string;
  readonly with?: unknown;
  readonly as?: string;
}

/**
 * A batch: a script whose steps call actions, with no parameters
 * (`packages/core/docs/spec/model-command-language.md`, section Script). This
 * package runs the batches whose steps are only calls; a batch with `when`,
 * `each` or `fail` runs through the script runner of the engine.
 */
export interface Batch {
  readonly commands: readonly BatchCall[];
  /** A placeholder giving the result of the batch; the result of its last call when absent. */
  readonly result?: string;
}

/** What a batch gives: its result, and the entry of each of its calls, in order. */
export interface BatchOutcome {
  readonly result: unknown;
  readonly entries: readonly RunEntry[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_KEYS = new Set(["call", "with", "as"]);
/** A placeholder whose content is a path: a name, then segments that are identifiers, indexes or `*`. */
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z0-9_]+|\*))*$/;
const WHOLE = /^\$\{([^}]*)\}$/;
const ANY = /\$\{([^}]*)\}/g;

/** Checks the shape of a batch before any call runs. */
function checkBatch(batch: unknown): Batch {
  if (batch === null || typeof batch !== "object" || Array.isArray(batch)) {
    throw actionError("invalid_script_step", "a batch is an object with commands");
  }
  if ("parameters" in batch) throw actionError("invalid_script_step", "a batch has no parameters");
  const { commands, result } = batch as { commands?: unknown; result?: unknown };
  if (!Array.isArray(commands))
    throw actionError("invalid_script_step", "a batch has an array of commands");
  if (result !== undefined && typeof result !== "string") {
    throw actionError("invalid_script_step", "the result of a batch is a placeholder");
  }
  commands.forEach((step: unknown, index) => {
    const where = `step ${index}`;
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw actionError("invalid_script_step", `${where} is not a call`);
    }
    const keys = Object.keys(step);
    const other = keys.find((key) => !STEP_KEYS.has(key));
    if (other !== undefined || typeof (step as BatchCall).call !== "string") {
      throw actionError(
        "invalid_script_step",
        `${where} is not a call with only with and as${other ? ` (it has ${other})` : ""}; ` +
          "a batch with commands, when, each or fail runs through the script runner of the engine",
      );
    }
    const { as } = step as BatchCall;
    if (as !== undefined && (typeof as !== "string" || !IDENTIFIER.test(as))) {
      throw actionError("invalid_script_step", `${where}: as must be an identifier`);
    }
  });
  return batch as Batch;
}

/** Follows the segments of a path from a value, by the rules of placeholders on arrays. */
function follow(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return value;
  if (value === null || value === undefined) return undefined;
  const [segment, ...rest] = segments;
  if (Array.isArray(value)) {
    if (/^\d+$/.test(segment)) return follow(value[Number(segment)], rest);
    if (segment === "*") return value.map((entry) => follow(entry, rest));
    return follow(value[0], segments);
  }
  if (typeof value === "object") return follow((value as Record<string, unknown>)[segment], rest);
  return undefined;
}

/**
 * Resolves the `${name.path}` placeholders of a value against the results
 * named so far. A placeholder that is the whole string gives the value it
 * reaches, of any type; one inside text gives its text. A placeholder that is
 * not a path, such as `${now()}`, is kept for the called action.
 */
function resolve(value: unknown, names: ReadonlyMap<string, unknown>): unknown {
  const lookup = (path: string): unknown => {
    const [name, ...segments] = path.split(".");
    if (!names.has(name))
      throw actionError("unknown_reference", `\${${path}}: ${name} is not set yet`);
    return follow(names.get(name), segments);
  };
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole && PATH.test(whole[1])) return lookup(whole[1]);
    return value.replace(ANY, (text, content: string) => {
      if (!PATH.test(content)) return text;
      const found = lookup(content);
      if (found === null || found === undefined) return "";
      return typeof found === "object" ? canonicalJson(found) : String(found);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, names));
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = resolve(entry, names);
      if (result !== undefined) resolved[key] = result;
    }
    return resolved;
  }
  return value;
}

/**
 * Runs a batch of calls in order through a registry, each a run of
 * `registry.run` with the host, so the run log gets one entry per call.
 * Before each call, the placeholders of its `with` are resolved against the
 * results named by the `as` of earlier calls.
 *
 * The batch is checked whole before any call: a step that is not a `call`
 * with only `with` and `as`, or a batch with `parameters`, is refused with
 * `invalid_script_step`. A placeholder naming an `as` name not set yet is
 * refused with `unknown_reference`. A refused call stops the batch and its
 * exception is thrown as is.
 *
 * It opens no transaction: the host runs the whole batch in one, and rolls it
 * back when the batch throws, so a batch can be undone as one.
 */
export async function runBatch<C = RunTrace>(
  registry: ActionRegistry<C>,
  batch: Batch,
  host: RunHost<C> = {},
): Promise<BatchOutcome> {
  const { commands, result } = checkBatch(batch);
  const entries: RunEntry[] = [];
  const recording: RunHost<C> = {
    ...host,
    onEntry(entry) {
      entries.push(entry);
      host.onEntry?.(entry);
    },
  };
  const names = new Map<string, unknown>();
  let last: unknown;
  for (const step of commands) {
    const params = step.with === undefined ? undefined : resolve(step.with, names);
    last = (await registry.run(step.call, params, recording)).result;
    if (step.as !== undefined) names.set(step.as, last);
  }
  return { result: result === undefined ? last : resolve(result, names), entries };
}

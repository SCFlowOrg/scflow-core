import type { ValidateFunction } from "ajv/dist/2020.js";
import { actionError, errorCodeOf } from "./errors.js";
import { canonicalJson, copyJson } from "./json.js";
import { compileParameters, parametersSchema, validateParameters } from "./parameters.js";
import type { Action, RunEntry, RunHost, RunOutcome, RunStep, RunTrace } from "./types.js";

/** An action id: the namespace of its module, a slash and a name, both identifiers. */
const ACTION_ID = /^[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*$/;

/** A registry of actions, each known by its id. */
export interface ActionRegistry<C = RunTrace> {
  /**
   * Adds an action. Its id must be a namespace, a slash and a name, and its
   * parameters a valid JSON Schema object, or it is refused with
   * `constraint_violation`; an id already registered is refused with
   * `duplicate_name`.
   */
  register(action: Action<C>): void;
  /** The action with this id, or `undefined`. */
  get(id: string): Action<C> | undefined;
  /** Every action, in the order of registration. */
  list(): readonly Action<C>[];
  /**
   * Runs one action: checks its parameters (see `validateParameters`), runs its
   * body with the context the host builds, and records the call as a run
   * entry, which `host.onEntry` receives, done or refused. An id that names no
   * action is refused with `unknown_action`, and no entry is recorded.
   *
   * It opens no transaction: the host runs it inside the transaction of the
   * action.
   */
  run(id: string, params?: unknown, host?: RunHost<C>): Promise<RunOutcome>;
}

interface Registered<C> {
  readonly action: Action<C>;
  readonly validate: ValidateFunction;
}

/** The entry of each refused run, by its exception, so a caller records it as a step. */
const refusedEntries = new WeakMap<object, RunEntry>();

/** The run entry recorded for an exception a run threw, if any. */
export function entryOfRefusal(error: unknown): RunEntry | undefined {
  return error !== null && typeof error === "object" ? refusedEntries.get(error) : undefined;
}

/** The parameters as given, in canonical form, or their text when they are not JSON. */
function givenParameters(params: unknown): string {
  try {
    return canonicalJson(params === undefined ? {} : params);
  } catch {
    return JSON.stringify(String(params));
  }
}

/** Creates an empty registry. `C` is the context a host gives the bodies, the trace by default. */
export function createActionRegistry<C = RunTrace>(): ActionRegistry<C> {
  const actions = new Map<string, Registered<C>>();

  function refuse(error: unknown, action: string, parameters: string, steps: RunStep[]): never {
    const entry: RunEntry = {
      action,
      parameters,
      steps,
      outcome: "refused",
      error: errorCodeOf(error),
    };
    if (error !== null && typeof error === "object") refusedEntries.set(error, entry);
    throw error;
  }

  async function execute(id: string, params: unknown, host: RunHost<C>): Promise<RunOutcome> {
    const registered = actions.get(id);
    if (!registered) throw actionError("unknown_action", `no action ${id}`);
    const steps: RunStep[] = [];
    let checked: unknown;
    try {
      checked = await validateParameters(
        registered.action,
        params,
        host.resolveRef,
        registered.validate,
      );
    } catch (error) {
      refuse(error, id, givenParameters(params), steps);
    }
    const parameters = canonicalJson(checked);
    const trace: RunTrace = {
      action: id,
      command(command, result) {
        steps.push({ command: copyJson(command), result: canonicalJson(result) });
      },
      async call(calledId, calledParams) {
        try {
          const outcome = await execute(calledId, calledParams, host);
          steps.push({ call: outcome.entry });
          return outcome.result;
        } catch (error) {
          const entry = entryOfRefusal(error);
          if (entry) steps.push({ call: entry });
          throw error;
        }
      },
    };
    const context = host.context ? host.context(trace) : (trace as C);
    let result: unknown;
    try {
      result = await registered.action.run(checked, context);
    } catch (error) {
      refuse(error, id, parameters, steps);
    }
    const entry: RunEntry =
      result === undefined
        ? { action: id, parameters, steps, outcome: "done" }
        : { action: id, parameters, steps, outcome: "done", result: canonicalJson(result) };
    return { result, entry };
  }

  return {
    register(action) {
      if (typeof action.id !== "string" || !ACTION_ID.test(action.id)) {
        throw actionError(
          "constraint_violation",
          `"${action.id}" is not a namespace, a slash and a name`,
        );
      }
      if (actions.has(action.id))
        throw actionError("duplicate_name", `action ${action.id} is already registered`);
      const validate = compileParameters(action.id, parametersSchema(action));
      actions.set(action.id, { action, validate });
    },
    get: (id) => actions.get(id)?.action,
    list: () => [...actions.values()].map((registered) => registered.action),
    async run(id, params, host = {}) {
      try {
        const outcome = await execute(id, params, host);
        host.onEntry?.(outcome.entry);
        return outcome;
      } catch (error) {
        const entry = entryOfRefusal(error);
        if (entry) host.onEntry?.(entry);
        throw error;
      }
    },
  };
}

/** A run log: the entries of the runs it is given to, in order. */
export interface RunLog {
  readonly entries: readonly RunEntry[];
  /** Adds an entry; pass it as `RunHost.onEntry`. */
  readonly record: (entry: RunEntry) => void;
}

/** Creates an empty run log, kept in memory. */
export function createRunLog(): RunLog {
  const entries: RunEntry[] = [];
  return { entries, record: (entry) => void entries.push(entry) };
}

import { modelError, ModelError } from "./errors.js";
import { matchValueFilter } from "./filter.js";
import { resolveCommandForm } from "./command.js";
import { isModelSchema } from "./modelUpgrade.js";
import { readsClock, substitutePlaceholders } from "./placeholders.js";
import type { AuthoredCommand, CommandResult, TransientObject, TransientValue } from "./types.js";

/**
 * Procedures, per packages/core/docs/spec/model-command-language.md#script: a
 * script with parameters, the declared body of an action. A procedure emits
 * MCL commands and calls of other actions through its host, and nothing else,
 * so it follows the contract of a body (see meta-model.md#action) whatever the
 * host: an environment, a test, or another language replaying it.
 */

/** A procedure as a module declares it in the `body` of an action. */
export interface Procedure {
  /** The parameters, as JSON Schema; the host validates them before the procedure runs. */
  parameters?: unknown;
  /** The steps, run in order. */
  commands: readonly unknown[];
  /** A placeholder giving the result; the result of the last step that ran when absent. */
  result?: string;
}

/** What a procedure runs its steps through. */
export interface ProcedureHost {
  /**
   * Runs one command, in the transaction of the procedure. A placeholder reading
   * the clock is still in the command: the host records it as it is and runs
   * the result of `resolveClockPlaceholders`.
   */
  runCommand(command: AuthoredCommand): Promise<CommandResult>;
  /** Calls an action by id, in the same transaction. A `call` step without it is refused with `unknown_action`. */
  call?(id: string, params: unknown): Promise<unknown>;
}

const COMMAND_KINDS = ["kind", "query", "create", "update", "delete"];
const COMMON_KEYS = new Set(["as", "when"]);

/** What an absent parameter gives a property of an input: the property is left out. */
const ABSENT = Symbol("absent parameter");

/** What `resolve` leaves unresolved. */
interface Keep {
  self?: boolean;
  clock?: boolean;
}

type StepForm = "command" | "call" | "each" | "fail";

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The form of a step, or `invalid_script_step` when it is not exactly one of a command, a `call`, an `each` with its `do`, or a `fail`. */
function formOf(step: unknown, where: string): StepForm {
  if (!isMapping(step)) throw modelError("invalid_script_step", `${where} must be a mapping`);
  const forms: StepForm[] = [];
  if (COMMAND_KINDS.some((k) => k in step)) forms.push("command");
  if ("call" in step) forms.push("call");
  if ("each" in step) forms.push("each");
  if ("fail" in step) forms.push("fail");
  if (forms.length !== 1) {
    throw modelError("invalid_script_step", `${where} is ${forms.length === 0 ? "none" : forms.join(" and ")} of a command, a call, an each or a fail; a step is exactly one`);
  }
  const form = forms[0];
  const allowed: Record<StepForm, string[]> = {
    command: [],
    call: ["call", "with"],
    each: ["each", "do"],
    fail: ["fail"],
  };
  if (form !== "command") {
    const extra = Object.keys(step).filter((k) => !COMMON_KEYS.has(k) && !allowed[form].includes(k));
    if (extra.length > 0) throw modelError("invalid_script_step", `${where} is a ${form} step and cannot carry ${extra.map((k) => `"${k}"`).join(", ")}`);
  }
  if (form === "each" && !Array.isArray(step.do)) throw modelError("invalid_script_step", `${where} is an each step and needs a "do" list of steps`);
  if (form === "call" && typeof step.call !== "string") throw modelError("invalid_script_step", `${where}: "call" names an action by its id`);
  if (step.as !== undefined && typeof step.as !== "string") throw modelError("invalid_script_step", `${where}: "as" is an identifier`);
  return form;
}

/**
 * Resolves the placeholders of `value` against `context`. A string that is one
 * whole placeholder naming an absent parameter (`${params.x}`) gives `ABSENT`,
 * which a mapping leaves out and an array reads as `null`. A string holding a
 * path on `this` is kept when `keep.self` is set: a filter resolves it per
 * instance (see Filter, *Paths on the right*). A placeholder reading the clock
 * is kept when `keep.clock` is set: the host resolves it (see
 * `resolveClockPlaceholders`).
 */
function resolve(value: unknown, context: Record<string, TransientValue>, keep: Keep = {}): TransientValue | typeof ABSENT {
  if (typeof value === "string") {
    if (keep.self && /\$\{\s*this[.}\s]/.test(value)) return value;
    if (!value.includes("${")) return value;
    try {
      return substitutePlaceholders(value, context, keep.clock ? readsClock : undefined);
    } catch (error) {
      const whole = /^\$\{\s*params\.[^}]*\}$/.test(value.trim());
      if (whole && error instanceof ModelError && error.code === "unknown_reference") return ABSENT;
      throw error;
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => {
      const r = resolve(v, context, keep);
      return r === ABSENT ? null : r;
    });
  }
  if (isMapping(value)) {
    const out: TransientObject = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolve(v, context, keep);
      if (r !== ABSENT) out[k] = r;
    }
    return out;
  }
  return (value ?? null) as TransientValue;
}

function resolved(value: unknown, context: Record<string, TransientValue>, keep: Keep = {}): TransientValue {
  const r = resolve(value, context, keep);
  return r === ABSENT ? null : r;
}

/**
 * Runs `procedure` with `params` through `host` and returns its result: its
 * `result` resolved when given, else the result of the last step that ran.
 *
 * Each step is a command, a `call`, an `each` with its `do`, or a `fail`; `as`
 * names its result for later placeholders, and a step whose `when` does not
 * hold on the parameters and the named results is skipped, its `as` left
 * unset. An `each` runs its `do` once per entry of the array it gives, the
 * entry named by `as`, and a name set inside `do` stays local to that run. A
 * `fail` refuses the procedure with `procedure_failed` and its message. A
 * command's `input`, `filters` and `result`, and a call's `with`, are resolved
 * first; a `${this...}` of a filter is left for the command, and a placeholder
 * reading the clock in `input`, `filters` or `with` is left for the host, so
 * that the run log records it as the procedure emitted it.
 *
 * Throws `invalid_script_step` for a step of another shape, `procedure_failed`,
 * `unknown_reference` for a placeholder that does not resolve, `unknown_action`
 * for a call the host cannot make, and whatever a command or a call throws.
 */
export async function runProcedure(procedure: Procedure, params: unknown, host: ProcedureHost): Promise<unknown> {
  if (!isMapping(procedure) || !Array.isArray(procedure.commands)) {
    throw modelError("invalid_script_step", "a procedure holds a list of commands");
  }
  const context: Record<string, TransientValue> = { params: (params ?? {}) as TransientValue };
  const state = { last: null as unknown };
  await runSteps(procedure.commands, context, host, state, "commands");
  if (procedure.result !== undefined) return resolved(procedure.result, context);
  return state.last;
}

async function runSteps(
  steps: readonly unknown[],
  context: Record<string, TransientValue>,
  host: ProcedureHost,
  state: { last: unknown },
  where: string,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const at = `${where}[${i}]`;
    const form = formOf(steps[i], at);
    const step = steps[i] as Record<string, unknown>;
    if (step.when !== undefined && !matchValueFilter(context as TransientObject, step.when)) continue;
    let result: unknown;
    switch (form) {
      case "command": {
        const command: Record<string, unknown> = { ...step };
        delete command.as;
        delete command.when;
        if (command.input !== undefined) command.input = resolved(command.input, context, { clock: true });
        if (command.filters !== undefined) command.filters = resolved(command.filters, context, { self: true, clock: true });
        result = await host.runCommand(command);
        break;
      }
      case "call": {
        if (!host.call) throw modelError("unknown_action", `${at} calls "${String(step.call)}", and the host of this procedure calls no action`);
        result = await host.call(step.call as string, step.with === undefined ? {} : resolved(step.with, context, { clock: true }));
        break;
      }
      case "each": {
        const entries = resolved(step.each, context);
        if (!Array.isArray(entries)) throw modelError("invalid_script_step", `${at}: "each" gives ${JSON.stringify(entries)}, not an array`);
        for (const entry of entries) {
          const local: Record<string, TransientValue> = { ...context };
          if (typeof step.as === "string") local[step.as] = entry;
          await runSteps(step.do as unknown[], local, host, state, `${at}.do`);
        }
        continue;
      }
      case "fail": {
        const message = resolved(step.fail, context);
        throw modelError("procedure_failed", typeof message === "string" ? message : JSON.stringify(message));
      }
    }
    state.last = result;
    if (typeof step.as === "string") context[step.as] = result as TransientValue;
  }
}

/**
 * The command a host runs for a command emitted by a body: the placeholders
 * reading the clock in its `input` and `filters` resolved, every other
 * placeholder left as it is, and `command` unchanged so that it can be recorded.
 * The `input` of a command on a model schema is left whole: a `default_value`
 * in it belongs to the instances that schema will construct.
 */
export function resolveClockPlaceholders(command: AuthoredCommand): AuthoredCommand {
  const form = resolveCommandForm(command);
  const onlyClock = (content: string) => !readsClock(content);
  if (form.filters !== undefined) form.filters = substitutePlaceholders(form.filters as TransientValue, {}, onlyClock);
  if (form.input !== undefined && !isModelSchema(form.schema as string)) {
    form.input = substitutePlaceholders(form.input as TransientValue, {}, onlyClock);
  }
  return form as unknown as AuthoredCommand;
}

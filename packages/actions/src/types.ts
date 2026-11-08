/**
 * The types of the action contract (`packages/core/docs/spec/meta-model.md`,
 * section Action). They hold no model: an action is an id, a description for
 * people and AI, its parameters as JSON Schema and a body.
 */

/** A JSON Schema, as plain data. */
export type JsonSchema = { readonly [keyword: string]: unknown };

/**
 * The declaration of an action, apart from its body. It matches an MCP tool
 * definition: `id` gives the tool name, `description` and `parameters` the
 * description and input schema, `kind: "read"` the read-only hint and
 * `destructive` the destructive hint.
 */
export interface ActionDefinition {
  /** The namespace of the module, a slash and a name, for example `scflow/create_actor`. */
  readonly id: string;
  /** A short label for people, used in a user interface and an undo history. */
  readonly title?: string;
  /** What the action does, for people and AI assistants. */
  readonly description?: string;
  /** `read` writes nothing; `action`, the default, writes. */
  readonly kind?: "read" | "action";
  /** Whether the action may destroy data. */
  readonly destructive?: boolean;
  /** Whether an AI sees the action: `visible`, the default, or `hidden`. */
  readonly exposure?: "visible" | "hidden";
  /**
   * The parameters, a JSON Schema object (draft 2020-12), or its JSON text as a
   * manifest holds it. It may use the keyword `ref`, which names a schema of
   * the model: see `RefResolver`. Absent, the action takes an empty object.
   */
  readonly parameters?: JsonSchema | string;
  /** The schemas the action writes. Kept for the engine, which enforces it. */
  readonly writes?: readonly string[];
}

/**
 * The trace of one run: a body records through it each command it emits, with
 * its result, and calls other actions. A host builds the context of the body
 * from it (`RunHost.context`); without a host context, the body receives the
 * trace itself.
 */
export interface RunTrace {
  /** The id of the running action. */
  readonly action: string;
  /**
   * Records a command as the body emitted it, before its placeholders are
   * resolved, with the result the engine gave.
   */
  command(command: unknown, result: unknown): void;
  /**
   * Runs another action of the registry with the same host, and records the
   * call as a step of this run. It resolves to the result of the called action,
   * and rejects with its exception.
   */
  call(id: string, params?: unknown): Promise<unknown>;
}

/**
 * An action: its declaration and its body. The body is `run(params, context)`;
 * it receives the parameters after their check, with each `ref` resolved to a
 * key, and the context the host builds. Following the contract of a body, its
 * only effect is to emit commands and calls through that context.
 */
export interface Action<C = RunTrace> extends ActionDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(params: any, context: C): unknown;
}

/**
 * The instances a `ref` value names, as the engine finds them: the key of the
 * instance whose id is the value, if any, and the keys of the instances whose
 * `display_name` is the value, in any language.
 */
export interface RefMatches {
  readonly id: string | null;
  readonly names: readonly string[];
}

/**
 * Finds the instances of `schema` a `ref` value names. The engine gives it,
 * since this package reads no instance; the package applies the rule of
 * resolution (see `validateParameters`).
 */
export type RefResolver = (schema: string, value: string) => RefMatches | Promise<RefMatches>;

/** What a host gives a run: the context of bodies, the resolver of `ref` and the run log. */
export interface RunHost<C = RunTrace> {
  /** Builds the context a body receives from the trace of its run. Absent, the body receives the trace. */
  context?(trace: RunTrace): C;
  /** Resolves the `ref` values of parameters. Absent, a `ref` value is given to the body as it is. */
  resolveRef?: RefResolver;
  /** Receives the entry of each top-level call, done or refused. A nested call is a step of its caller. */
  onEntry?(entry: RunEntry): void;
}

/** One call of an action, as it ran (`run_entry` of the specification). */
export interface RunEntry {
  /** The id of the action. */
  readonly action: string;
  /** The parameters in canonical JSON, after their check with each ref resolved; as given when they were refused. */
  readonly parameters: string;
  /** What the body emitted, in order. */
  readonly steps: readonly RunStep[];
  readonly outcome: "done" | "refused";
  /** The code of the exception of a refused call, or its message when it has no code. */
  readonly error?: string;
  /** The result of the action in canonical JSON; absent when the action returned none. */
  readonly result?: string;
}

/** One effect of a body (`run_step`): a command with its result, or a call. */
export type RunStep =
  { readonly command: unknown; readonly result: string } | { readonly call: RunEntry };

/** What a run gives: the result of the body and the entry of the call. */
export interface RunOutcome {
  readonly result: unknown;
  readonly entry: RunEntry;
}

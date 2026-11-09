/**
 * Value types of the command language and the contract a persistent format
 * implements. Usage: `docs/mcl.md`.
 */

/** The identifier of an instance within its schema: its `name`, or its generated `id`. */
export type Key = string;

/** A scalar value; `null` stands for the absence of a value. */
export type Scalar = string | number | boolean | null;

/** The plain, JSON-serializable form of every instance and result: a scalar, an array or a mapping of those. */
export type TransientValue =
  | Scalar
  | TransientValue[]
  | { [property: string]: TransientValue };

/** A plain object form of TransientValue — what an instance always is. */
export type TransientObject = { [property: string]: TransientValue };

// ---------------------------------------------------------------------------
// Filter (docs/commands.md)
// ---------------------------------------------------------------------------

/** The reserved keys of a filter: `and` and `or` take arrays of filters, `not` takes one filter. */
export interface FilterCombinators {
  and?: Filter[];
  or?: Filter[];
  not?: Filter;
}

/** A predicate value is a literal (shorthand for `eq`) or an operator map. */
export type FilterPredicate = TransientValue | { [operator: string]: TransientValue };

/** `and` / `or` / `not` are reserved; every other key is a property-path predicate. */
export type Filter = FilterCombinators & { [propertyPath: string]: unknown };

// ---------------------------------------------------------------------------
// Command / Script (docs/commands.md)
// ---------------------------------------------------------------------------

/** The four operations a command performs on the instances of one schema. */
export type CommandKind = "query" | "create" | "update" | "delete";

/** Every `CommandKind`, in the order `query`, `create`, `update`, `delete`. */
export const COMMAND_KINDS: readonly CommandKind[] = ["query", "create", "update", "delete"];

/**
 * Shapes the result a command returns (see `docs/commands.md`, Result).
 * Narrows what comes back; never changes which instances the command acts on.
 * Absent — the whole property — leaves the result exactly as every command
 * produces it.
 */
export interface ResultOptions {
  /**
   * The properties each returned object carries. Absent: all of them. Empty:
   * the key alone — every returned object keeps whichever of `name`/`id` it
   * has, so it stays addressable, whatever this lists.
   */
  properties?: string[];
  /**
   * `false` returns `before` and `updated-before` empty, `true` fills them.
   * Defaults to `false` for `kind: query` — a query's `before` and `after`
   * are always identical copies of the same selected instances, so filling
   * both would be pure duplication — and to `true` for `create`, `update`
   * and `delete`, where `before` and `after` differ and both carry
   * information.
   */
  before?: boolean;
}

/**
 * A patch value of an `update` that edits the current value of a `string`
 * property in place instead of replacing it (see `docs/commands.md`, Text
 * operations). A mapping with exactly one of the two keys.
 */
export interface TextOperation {
  /** Appended to the end of the current value, with no separator. `null` counts as the empty text. */
  append?: string;
  /**
   * `find` (non-empty, literal, case-sensitive) is replaced by `with`: one
   * occurrence exactly, or every occurrence (at least one) with `all: true`.
   */
  replace?: { find: string; with: string; all?: boolean };
}

/** A command in canonical form: the `kind` of operation, its target `schema`, and the optional `filters`, `input` and `result`. */
export interface Command {
  kind: CommandKind;
  schema: string;
  /**
   * Which instances the command reaches: `""` (the default) the dataset's own;
   * the namespace of an import, ending with a dot, the instances of that
   * import; `*` every instance, own and imported. Any value but `""` is for a
   * `query` only: imported instances are read-only.
   */
  namespace?: string;
  filters?: Filter;
  input?: TransientValue[];
  /** `delete` only: also removes the instances that reach a removed one through an `on_delete: confirm` relation. False by default. */
  cascade?: boolean;
  result?: ResultOptions;
}

/**
 * The authored (possibly sugared) form of a Command or ScriptCommand:
 * `query`/`create`/`update`/`delete` are accepted as top-level keys instead
 * of `kind`+`schema`, the key naming `kind` and its value naming `schema`.
 * Deliberately as loose as `Record<string, unknown>` — not `TransientObject`,
 * so a caller can pass an `unknown`-typed field (e.g. a key read off a
 * previous result) straight through without a cast, the same way
 * `JSON.parse`'s return type would be handled. `resolveCommandForm`
 * validates and normalizes it at runtime; the result is cast to
 * `Command`/`ScriptCommand` once resolved.
 */
export type AuthoredCommand = Record<string, unknown>;

/** A Script whose commands may be in `AuthoredCommand` (sugared) form. */
export interface AuthoredScript {
  commands: AuthoredCommand[];
}

/**
 * The answer to a command: five lists of instances in transient form.
 * `before` and `after` hold the matched instances as they were and as they are;
 * `cascade-deleted` the instances removed with their owner; `updated-before`
 * and `updated-after` the instances of other schemas that changed as a side
 * effect.
 */
export interface CommandResult {
  before: TransientValue[];
  after: TransientValue[];
  "cascade-deleted": TransientValue[];
  "updated-before": TransientValue[];
  "updated-after": TransientValue[];
}

/**
 * What a package that must not embed `core` receives to read and write a
 * dataset by locator, knowing no document. The `runCommand` and `runScript`
 * functions of `core`, and `ApiSession`, have these signatures.
 */
export interface MclAccess {
  runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult>;
  runScript(locator: string, script: AuthoredScript): Promise<CommandResult>;
}

/** A command of a script; `as` names its result so that later commands read it through a placeholder. */
export interface ScriptCommand extends Command {
  as?: string;
}

/** An ordered list of commands run on one dataset; the result of a script is the result of its last command. */
export interface Script {
  commands: ScriptCommand[];
}

// ---------------------------------------------------------------------------
// Observable notifications (docs/observability.md)
// ---------------------------------------------------------------------------

/**
 * The changes of one transaction to the instances of `observable` schemas, one
 * entry per touched instance. `before` is `null` for a created instance and
 * `after` for a deleted one. `via` names an `observable` relation whose target
 * changed: the instance itself was not touched, and `before` equals `after`.
 */
export type ObservableDelta = Array<{
  schema: string;
  key: string;
  before: TransientValue | null;
  after: TransientValue | null;
  via?: string;
}>;

/**
 * A notification delivered to an observer: a `delta` after a committed
 * transaction, an undo or a redo, or a `reset` after `initDataset`,
 * `restoreDataset` or `deleteDataset`, which carries no changes.
 */
export type ObservableChange =
  | { kind: "delta"; changes: ObservableDelta }
  | { kind: "reset" };

/** A callback registered with `subscribeObservable`. */
export type ObservableListener = (change: ObservableChange) => void;

// ---------------------------------------------------------------------------
// Persistence interface
// ---------------------------------------------------------------------------

/**
 * The storage contract of a persistent format, registered with
 * `registerPersistentFormat`. `core` runs the whole command language on top
 * of it and depends on no format. `rest` is the part of a locator after the
 * format prefix, whose meaning the format decides.
 *
 * The interface is deliberately low-level: raw storage of instances by key.
 * Command processing and schema processing are generic and run once above it.
 * A `schema`, `scalar_type`, `import` or `module` (the manifest of a module the
 * dataset uses, by module key) is an ordinary root-schema instance,
 * read with `listInstances`/`getInstance` like any other, through no dedicated
 * accessor. Keys are local to the dataset, never namespaced. Reads reflect what
 * is stored at the time of the call, never a copy kept from an earlier call or
 * another caller: a format holding an index or a cache revalidates it against
 * its storage. Reads take no lock. Every function but `createDataset` throws
 * `dataset_not_found` when `rest` resolves to no dataset; `createDataset`
 * throws `dataset_already_exists` when it does.
 */
export interface PersistenceInterface {
  /** The format prefix this implementation answers to, e.g. "js", "obsidian". */
  readonly name: string;

  /**
   * Whether this format permits `ApiSession`'s transaction and revert methods
   * to run against it. `false` when absent. The mechanism is generic, built on
   * `getInstance`/`putInstance`/`deleteInstance` below; this flag only says
   * whether it is safe to run. A format whose data a human or another tool can
   * change outside the session leaves it `false`, because a recorded snapshot
   * could then differ from what is stored when it would be replayed.
   * The writes of a command reach the format as the command runs. A format
   * whose writes land in storage at once, the in-memory `js` format among them,
   * needs nothing more: the prepare phase of a transaction only checks and marks
   * it, and the finalize phase only closes it. A format backed by a database
   * maps the two phases onto the database's own prepare and commit, or onto a
   * write followed by a compensating step on rollback.
   */
  readonly supportsTransactions?: boolean;

  // dataset lifecycle
  /** Whether a dataset exists at `rest`. */
  datasetExists(rest: string): Promise<boolean>;
  /** Creates an empty dataset named `name` at `rest` and returns its transient form; throws `dataset_already_exists` when one is there. */
  createDataset(rest: string, name: string): Promise<TransientValue>;
  /**
   * Returns the properties stored on the dataset at `rest` (`name`, the four
   * versions, `created_at`, `updated_at`, and `modules`, the list of
   * `dataset_module` entries, once the dataset uses a module); throws
   * `dataset_not_found` when none is there. Not `schemas`, `scalar_types`,
   * `imports` or the manifests of the modules: those are read with
   * `listInstances`.
   */
  getDataset(rest: string): Promise<TransientValue>;
  /**
   * Merges `patch` into the scalar properties of the dataset at `rest` and
   * returns the dataset as it is afterwards. The engine calls it to bump a
   * version after a change: a model version after a `schema` or `scalar_type`
   * change, `data_minor_version` after a data change, `modules` when the
   * modules of the dataset change. A format keeps every key it is given.
   */
  updateDataset(rest: string, patch: TransientValue): Promise<TransientValue>;
  /**
   * Removes the dataset at `rest`: the storage primitive behind the API's
   * `deleteDataset`, which captures the dataset's transient form before
   * calling it.
   */
  deleteDataset(rest: string): Promise<void>;

  // instance storage, generic over every schema including `schema` and `scalar_type` themselves
  /**
   * Returns the instance of `schema` stored under `key`, or `null`.
   * `propertyRoles` is `Record<role, propertyName>` — at most one property per
   * role (`content`, `folder`), derived from that schema's `is_content`/
   * `is_folder` property constraints by schema processing, never by the
   * implementation itself. Always `{}` for `schema`/`scalar_type`/`import`.
   * An implementation is free to act on the roles it understands and must
   * otherwise leave the marked properties as ordinary instance data — ignoring
   * this parameter entirely is always a valid, just plainer, implementation.
   * The other instance methods take the same `propertyRoles`.
   */
  getInstance(rest: string, schema: string, key: Key, propertyRoles: Record<string, string>): Promise<TransientValue | null>;
  /** Returns every instance of `schema`. */
  listInstances(rest: string, schema: string, propertyRoles: Record<string, string>): Promise<TransientValue[]>;
  /**
   * Stores `instance` under `key`: a create for a new key, an update for an
   * existing one, replacing the instance already there. The instance is already
   * fully resolved (defaults and placeholders applied, constraints checked,
   * relations updated): store exactly what is given, without re-validating.
   */
  putInstance(rest: string, schema: string, key: Key, instance: TransientValue, propertyRoles: Record<string, string>): Promise<void>;
  /**
   * Removes the one instance of `schema` stored under `key`, nothing more: the
   * engine has already worked out the cascade deletion. Throws `key_not_found`
   * when none is there.
   */
  deleteInstance(rest: string, schema: string, key: Key): Promise<void>;

  // concurrency (optional)
  /**
   * Takes `rest`'s exclusive write lock and resolves to the function that
   * releases it. A format that provides it serializes its writers: the
   * generic layer takes the lock around each `runCommand`/`runScript`/
   * `ScriptSession.run` and from `beginTransaction` to the commit or rollback
   * of a transaction, so version bumps and the uniqueness check of a supplied `id` never interleave between
   * callers. Not re-entrant: the generic layer never takes it twice for one
   * piece of work. A format without it supports one caller at a time.
   */
  lock?(rest: string): Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------------------
// Normalized schema shapes — the output of schema processing.
//
// These hold plain values only (strings, booleans, arrays, records), so a
// NormalizedSchema is stored directly with putInstance(rest, "schema", name,
// schema) and read back unchanged: a schema is an ordinary instance as far as
// storage goes. `constraints` is a flat record from constraint name to value;
// names are unique within their scope.
// ---------------------------------------------------------------------------

/** A property of a normalized schema, with its type and its constraints. */
export interface NormalizedProperty {
  name: string;
  /** A scalar type name or a schema name. Never carries "[]" sugar — see `constraints.is_array`. */
  type: string;
  /**
   * Raw, unresolved (may contain ${...} placeholders). Null if not authored.
   * A string for a scalar or a relation; an array or a map may also hold its
   * default as the list or the mapping itself.
   */
  default_value: string | TransientValue[] | TransientObject | null;
  /** Raw, unresolved. Null if not authored (falls back to the type's null value). */
  null_value: string | null;
  constraints: Record<string, TransientValue>;
}

/** A schema after schema processing: the authored sugar resolved, with its own properties and constraints. */
export interface NormalizedSchema {
  name: string;
  description: string;
  /**
   * The schema's own content: the `is_content` property of the `schema`
   * meta-schema, so a format that separates an instance's primary content from
   * its fields keeps it there (the `obsidian` format: the body of the schema's
   * note). Own, never inherited through `extends`, the same as `description`.
   */
  content: string;
  extends: string | null;
  cannot_be_extended: boolean;
  properties: NormalizedProperty[];
  constraints: Record<string, TransientValue>;
}

/** A scalar type after schema processing: the type it extends and its constraints. */
export interface NormalizedScalarType {
  name: string;
  extends: string | null;
  constraints: Record<string, TransientValue>;
}

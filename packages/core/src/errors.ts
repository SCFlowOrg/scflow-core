/**
 * The error class every failure of the engine uses: callers branch on `.code`,
 * never on a message.
 */

/** Every code a `ModelError` carries, each with the condition that raises it. */
export const ErrorCode = {
  // Datasets and persistent formats
  /** The format prefix of a locator is not registered. */
  unknown_persistent_format: "unknown_persistent_format",
  /** A dataset already exists at the locator given to `initDataset` or `restoreDataset`. */
  dataset_already_exists: "dataset_already_exists",
  /** No dataset exists at the locator. */
  dataset_not_found: "dataset_not_found",
  /** A `schema` or a `scalar_type` is created under a name the model already uses. */
  duplicate_name: "duplicate_name",
  /** A storage operation names a key that no instance holds, or a module set is asked for a module it does not hold. */
  key_not_found: "key_not_found",
  /** A dump does not parse, or lacks the structure `dumpDataset` writes. */
  invalid_dump: "invalid_dump",

  // Command
  /** A command is not a mapping, or carries neither `kind` nor one of `query`, `create`, `update`, `delete`. */
  missing_command_kind: "missing_command_kind",
  /** A command carries several of `query`, `create`, `update`, `delete`, or one of them together with `kind`. */
  ambiguous_command_kind: "ambiguous_command_kind",
  /** A command carries a key other than `kind`, `schema`, `namespace`, `filters`, `input`, `result` and `as`. */
  unknown_command_property: "unknown_command_property",
  /**
   * `schema` of a command names no schema of the model, or an embedded schema,
   * which is not queryable. In a module set, a name that does not resolve where
   * it is written (`ModuleSet.requireSchema`): a short name is never searched
   * for across modules.
   */
  unknown_schema: "unknown_schema",
  /** An `update` carries no `input`. */
  empty_input: "empty_input",
  /**
   * An `input` is malformed or breaks a constraint of its schema. Also raised
   * for a constraint value a schema or property description cannot take (such
   * as a `ui_access` outside its three levels), for `create` and `delete` on
   * `dataset`, and for a text or map operation used where it does not apply, and
   * for a map whose key, value or entry count breaks its type or constraints, and
   * for a schema that breaks the rules
   * or of a facet (see `docs/modules.md`, *Facets*).
   */
  constraint_violation: "constraint_violation",
  /**
   * `result` is not a mapping, or carries a key other than `properties` or
   * `before`. A name in `result.properties` that the target schema does not
   * declare throws `unknown_property` instead.
   */
  unknown_result_option: "unknown_result_option",
  /**
   * A text operation (an `update` patch value that is a mapping) whose key is
   * neither `append` nor `replace`, or that carries several keys. Malformed
   * operands of a valid operation throw `constraint_violation` instead.
   */
  unknown_text_operation: "unknown_text_operation",
  /** A `replace` finds no occurrence of `find` in the current value (`all: true` included). */
  text_not_found: "text_not_found",
  /** A `replace` without `all: true` finds several occurrences of `find`. */
  text_not_unique: "text_not_unique",
  /**
   * A map operation (an `update` patch value that is a mapping with the single
   * key `set` or `remove`, where that name is not a valid key of the map type)
   * whose operand has the wrong shape: not a mapping for `set`, not an array of
   * keys for `remove`.
   */
  invalid_map_operation: "invalid_map_operation",
  /** A relation value is not the key of an instance of the relation's schema or of a schema extending it. */
  unknown_relation_target: "unknown_relation_target",
  /** `schema` of a command names a facet: its values are reached only through its target (see `docs/modules.md`, *Facets*). */
  facet_not_addressable: "facet_not_addressable",

  // Model upgrade
  /** A `schema` or `scalar_type` command runs against a locator that is not an upgrade locator. */
  not_upgrade_locator: "not_upgrade_locator",
  /** A data command runs against an upgrade locator. */
  upgrade_locator: "upgrade_locator",
  /**
   * A model change cannot be applied to the stored instances
   * (`upgradeDataset`, `setLocalModule`, and `upgradeModule` after its
   * migrations, or a migration it cannot run), or an instance cannot take the
   * current definition of a built-in schema (`restoreDataset`). Nothing is
   * changed.
   */
  incompatible_upgrade: "incompatible_upgrade",

  // Actions
  /** An action id names no action that the caller can reach: no module of the dataset declares it, or it belongs to a module the calling action does not depend on. */
  unknown_action: "unknown_action",
  /** A `create`, `update` or `delete` of data runs outside an action (see Writes and actions in `docs/spec/typescript-reference-implementation.md`). */
  write_outside_action: "write_outside_action",
  /** An action writes a schema outside its `writes`, or a property of a facet of another module (see Action, Write limit, in `docs/spec/meta-model.md`). */
  write_not_declared: "write_not_declared",
  /** A `fail` step of a procedure runs: the procedure, and its transaction, are refused with its message. */
  procedure_failed: "procedure_failed",
  /** A step of a script or a procedure is not exactly one of a command, a `call`, an `each` with its `do`, or a `fail`. */
  invalid_script_step: "invalid_script_step",
  /** An action that writes runs on a dataset a host opened read only, on request or because a module it uses is not installed at its version (see Model Upgrade, Opening a dataset, in `docs/spec/meta-model.md`). */
  read_only_dataset: "read_only_dataset",

  // Rules
  /**
   * The end of a transaction finds a declared rule broken (`checks`, `unique`,
   * `acyclic`, see `docs/rules.md`). `details` gives the first breach as `rule`,
   * `schema` and `key`, and every breach found in `violations`. Nothing the
   * transaction wrote is kept.
   */
  rule_violation: "rule_violation",

  // Transactions
  /** A transaction or `revert` call on a locator whose format does not set `supportsTransactions`. */
  transactions_not_supported: "transactions_not_supported",
  /** `prepareTransaction`, `commitTransaction`, `rollbackTransaction` or `revert` on a locator with no open transaction in this session. */
  no_transaction_in_progress: "no_transaction_in_progress",
  /** `commitTransaction` or `rollbackTransaction` with a `transactionId` that is not the one of the open transaction. */
  transaction_id_mismatch: "transaction_id_mismatch",
  /** `prepareTransaction` while the open transaction is nested more than one deep. */
  transaction_not_outermost: "transaction_not_outermost",
  /** A command, script, script session, `revert`, `beginTransaction` or `prepareTransaction` on a locator whose open transaction is already prepared. */
  transaction_prepared: "transaction_prepared",
  transaction_open: "transaction_open",
  no_transaction: "no_transaction",
  /** `revert` with a value that is not a delta returned by `prepareTransaction`. */
  invalid_delta: "invalid_delta",
  /** `revert` when the dataset's versions differ from the versions the delta embeds. */
  stale_delta: "stale_delta",

  // Schema processing
  /** `extends` names a schema or scalar type that does not exist, or an inverse relation targets an unknown schema. */
  unknown_extends_target: "unknown_extends_target",
  /** A schema extends itself through its chain of parents. */
  extends_cycle: "extends_cycle",
  /** A schema declares the same property name twice. */
  duplicate_property_name: "duplicate_property_name",
  /**
   * A property overriding an inherited one of the same name states a
   * different `type`. Restating the inherited type is allowed, as it is what
   * makes the two the same property; changing it is not an override, so it is
   * rejected.
   */
  property_type_change: "property_type_change",
  /** An `inverse_name` is already a property of the target schema and is not a generated inverse relation. */
  inverse_name_conflict: "inverse_name_conflict",
  /** A property `type` is neither a known scalar type nor a schema. */
  unknown_scalar_type: "unknown_scalar_type",

  // Modules
  /**
   * A schema or a scalar type of a module refers, by a qualified name, to a
   * module that is neither its own, nor a dependency, nor `mcl:core`.
   */
  reference_outside_module: "reference_outside_module",
  /** Two modules of one module set declare the same namespace, or a module declares `mcl`, the namespace of `mcl:core`. */
  namespace_conflict: "namespace_conflict",

  // Import
  /** A command creates an `import`: only `createImport` does. */
  import_cannot_be_created: "import_cannot_be_created",
  /** `createImport` meets one of the issues `checkImport` reports. */
  cannot_import: "cannot_import",
  /** `refreshImport` finds the imported dataset using a version of a module the dataset has not upgraded to. */
  import_not_upgraded: "import_not_upgraded",

  // Filter
  /** A filter is not a mapping, an `and` or `or` is not an array, or a `not` is not a mapping. */
  invalid_filter: "invalid_filter",
  /** A property path of a filter, a name in `result.properties`, or the property given to `uiAccessOf` does not exist. */
  unknown_property: "unknown_property",
  /** A filter predicate names an operator that does not exist or does not apply to the property's type. */
  invalid_operator: "invalid_operator",
  /** A filter operand has the wrong type: a bare array, or an array operand of `eq` or `ne`, on a property that is not an array; or an `in` operand that is not an array. */
  type_mismatch: "type_mismatch",

  // Script
  /** A placeholder does not resolve: its root, function, `as` name or path is unknown. */
  unknown_reference: "unknown_reference",
} as const;

/** The name of one code of `ErrorCode`. */
export type ErrorCodeName = keyof typeof ErrorCode;

/**
 * The error the engine throws: `code` names the cause (see `ErrorCode`),
 * `message` describes it, and `details`, when a code defines it, holds what a
 * caller reads without parsing the message (see `rule_violation`).
 */
export class ModelError extends Error {
  readonly code: ErrorCodeName;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCodeName, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "ModelError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Builds a `ModelError`; `message` defaults to the code. */
export function modelError(code: ErrorCodeName, message?: string, details?: Record<string, unknown>): ModelError {
  return new ModelError(code, message, details);
}

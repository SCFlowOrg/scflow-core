# Typescript reference implementation

## API Import

*Definition.*

[Import](meta-model.md#import) can be queried through a query command using the `import` schema, but creating, updating and deleting will raise an exception, imports are `constant`, and creation will raise `import_cannot_be_created`.

After querying an import, `queryDataset` (see `@scfloworg/core`'s `docs/datasets.md`) can be used with the import locator to check if the imported dataset is reachable and see if the versions have changed.

The dedicated functions below must be used as specific processing is involved to create, realign and remove an import.

---
**Checking import compatibility.** Utility function to check for import compatibility — this could be done directly by querying the imports in both datasets, but is provided as a single call. `checkImport(locator, importedLocator)` reports:

| result field       | meaning                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canImport`         | whether the import is possible overall. It is false when the two datasets use two versions of one module. Special case: `locator` and `importedLocator` name the same dataset — `canImport` reflects that, and every other field below is null or empty.       |
| `backImport`        | the existing import, if any, of the *importer* (`locator`) inside the *imported* dataset (`importedLocator`). If not null, the import is not possible (it would create a cycle).              |
| `existingImport`    | the existing import, if any, of the *imported* dataset already present in the importer. If versions mismatch, import is not possible — realign first. If versions match, the import already exists and is not necessary. |
| `additionalImports` | pairs `{imported, existing}`, one per import already present in the *imported* dataset: `imported` is that nested import, `existing` is an import of the same target already present in the importer, or `null`. |

For each pair in `additionalImports`:
- `existing` not null, versions mismatch → import not possible, realign first
- `existing` not null, versions match → not re-imported, but caching policy is updated
- `existing` null → the nested import is copied into the importer with its content

```ts
interface CheckImportResult {
  canImport: boolean
  backImport: TransientValue
  existingImport: TransientValue
  additionalImports: { imported: TransientValue, existing: TransientValue }[]
}

function checkImport(locator: string, importedLocator: string): Promise<CheckImportResult>
```

*Exceptions.*

| exception                   | thrown when                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `unknown_persistent_format` | `locator` or `importedLocator` format prefix has no registered Persistence Interface |
| `dataset_not_found`         | `locator` or `importedLocator` does not resolve to an existing dataset              |

---
**Creating an import.** Will create a new import for the imported dataset, assigning a namespace and copying its instances. Nothing is done if the dataset is already imported. An exception is thrown if any issue described in `checkImport` is encountered. Returns the new or existing import.

```ts
function createImport(locator: string, importedLocator: string): Promise<TransientValue>
```

*Exceptions.*

| exception                   | thrown when                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `unknown_persistent_format` | `locator` or `importedLocator` format prefix has no registered Persistence Interface |
| `dataset_not_found`         | `locator` or `importedLocator` does not resolve to an existing dataset              |
| `cannot_import`             | Import is impossible, see `checkImport`                                             |

---
**Removing an import.** Will remove an import from a dataset. Returns a copy of the removed import.

```ts
function removeImport(locator: string, importKey: Key): Promise<TransientValue>
```

*Exceptions.*

| exception                   | thrown when                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `unknown_persistent_format` | `locator` format prefix has no registered Persistence Interface |
| `dataset_not_found`         | `locator` does not resolve to an existing dataset                |
| `key_not_found`             | Import does not exist                                            |

---
**Realigning an import.** Realigning an existing import is a refresh (see [Import Refresh](meta-model.md#import-refresh)). When the imported dataset uses a newer version of a module, the dataset must have upgraded to it first (see [Model Upgrade](meta-model.md#model-upgrade)). This is checked by comparing the versions of their modules.

**Refreshing an import.** Will check the versions, access the imported dataset and import its data (adding the namespace), overwriting the previously imported data in the dataset. The result contains the following information as lists of shallow copies:

- `added`: copy of new instances imported in the refresh
- `removed`: copy of instances removed during the refresh
- `before`: copy of imported instances updated during the refresh, old state
- `after`: copy of imported instances updated during the refresh, new state
- `updated-before`: instances not in the imported set updated by inverse relations, old state
- `updated-after`: instances not in the imported set updated by inverse relations, new state

Note that no cascade delete can happen during a refresh, as ownership does not cross import boundaries.

```ts
interface RefreshResult {
  added: TransientValue[]
  removed: TransientValue[]
  before: TransientValue[]
  after: TransientValue[]
  "updated-before": TransientValue[]
  "updated-after": TransientValue[]
}

function refreshImport(locator: string, importKey: Key): Promise<RefreshResult>
```

*Exceptions.*

| exception                   | thrown when                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `unknown_persistent_format` | `locator` or the locator in the import format prefix has no registered Persistence Interface |
| `dataset_not_found`         | `locator` or the locator in the import does not resolve to an existing dataset              |
| `key_not_found`             | Import does not exist                                                                        |
| `import_not_upgraded`       | The imported dataset uses a version of a module the dataset has not upgraded to             |

## API Model Upgrade

*Definition.*

**Upgrading a module.** A session upgrades one module of a dataset to a newer manifest, or to the same version with another digest, as [Model Upgrade](meta-model.md#model-upgrade) says. Opening a dataset, comparing its modules with the installed ones and choosing to open it read only belong to the host, which calls this function for each module to upgrade.

```ts
interface MigrationStep {
  module: string            // the key of the module
  from: string              // the version embedded before the upgrade
  to: string                // the version this migration reaches
  migration: TransientValue // the entry of the manifest
}

interface UpgradeModuleOptions {
  // Runs a migration the host has code for and returns true; returns false
  // to let the engine apply the declared form of the migration.
  migrate?: (step: MigrationStep) => Promise<boolean>
}

interface UpgradeModuleResult {
  module: string
  from: string
  to: string
  migrations: string[]      // the `to` of each migration that ran, in order
  changed: boolean          // whether an instance changed
  delta: Delta | null       // the delta of the transaction, or null on a format without transactions or in a joined transaction
}

ApiSession.upgradeModule(locator: string, manifest: ModuleManifest, options?: UpgradeModuleOptions): Promise<UpgradeModuleResult>
```

```ts
ApiSession.addModule(locator: string, manifests: ModuleManifest[]): Promise<string[]>   // the keys added, in order
```

- `addModule` embeds each manifest the dataset does not use, as Adding a module in Model Upgrade says, as one step: a refusal changes nothing. It fails with `transaction_open` while a transaction is open, `duplicate_name` for another version or digest of an embedded module, `constraint_violation` for a local module, and with what `createModuleSet` throws for the new set of modules. When nothing is added it gives `[]` and changes nothing.

- The upgrade runs in a transaction of its own, which the session opens, or joins the transaction the session has open on `locator`, and then `delta` is `null`. `migrate` runs its code through the same session, so its commands join that transaction. Each migration whose `migrate` returns false runs its declared form.
- On a format without transactions, an upgrade with no migration is checked before anything is written, so a refusal changes nothing. An upgrade that needs a migration fails with `transactions_not_supported`.
- The upgrade records the new manifest and its digest in the dataset, and bumps `data_minor_version` when an instance changed.

*Exceptions.*

| exception                    | thrown when                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `unknown_persistent_format`  | `locator` format prefix has no registered Persistence Interface                             |
| `dataset_not_found`          | `locator` does not resolve to an existing dataset                                           |
| `key_not_found`              | The dataset does not use the module                                                         |
| `constraint_violation`       | The manifest breaks the `module` schema, names a local module, or is older than the embedded one, or is the same version with the same digest |
| `transactions_not_supported` | The upgrade needs a migration and the format does not support transactions                  |
| `incompatible_upgrade`       | After the migrations, an instance does not match the installed schemas; nothing is changed  |

## Writes and actions

*Definition.*

Every function and session of the API refuses, with `write_outside_action`, a `create`, `update` or `delete` of data, in a command or in a script. This holds for `runCommand`, `runScript`, a `ScriptSession` and an `ApiSession`. A query needs no action.

The writes that stay below actions pass: a command on the schemas of the model, and everything the engine does itself, such as loading a dataset, a model upgrade and the creation of singleton instances.

```ts
Engine.createActionSession(): ApiSession
```

- An action session is an `ApiSession` that may write. It is for the one host that builds the context of an action, and that host checks the write limit before each command. Nothing else opens one.
- A host never hands an action session to a caller: a caller reaches a dataset through actions and queries.

The entry `@scfloworg/core/testing` holds an engine whose functions and sessions may write, so a test can set up data and check a command by itself. It is for tests only.

## Persistence Interface

*Definition.*

The contract a [Persistent Format](meta-model.md#persistent-formats) implements so the modelling language can run against it: the storage-side counterpart of the TypeScript API.

The interface is deliberately low-level, raw storage of instances by key. Command processing and schema processing are generic, written once above it, so a new format only stores instances; a `schema`, `scalar_type` or `import` is an ordinary instance to it.

A format provides:
- its `name`, the locator prefix;
- the dataset lifecycle: create, read and patch the scalar properties, delete;
- instance storage by key, generic over every schema, with the property roles it may act on;
- optionally a write `lock` and support for transactions.

The contract is stated by the doc comments of `PersistenceInterface` in `@scfloworg/core` (`src/types.ts`), and the rules of locators by its `docs/formats.md`.

## Action Package

*Definition.*

`@scfloworg/actions` holds the part of the [action](meta-model.md#action) contract that does not need the engine: the action type, the check of parameters, a registry, the batches made only of calls, the export to AI tools and the run log. It is neutral: it depends on no other package of SCFlow and knows no model, so a host that is not MCL, such as an application framework, uses it as it is. Its only dependency is the standard JSON Schema validator Ajv.

**The engine keeps what needs a dataset.** The package does not read instances and does not evaluate filters, so two parts of the contract are given to it by the engine, which plugs them in:

| Part | In the package | Given by the engine |
| --- | --- | --- |
| `ref` in `parameters` | Accepted as a keyword; applies the rule of resolution: an id wins over a name that equals it, and no instance or several are refused with `invalid_parameters` | A resolver that, for a schema and a value, gives the key of the instance whose id is the value, and the keys of the instances whose `display_name` is the value in any language |
| Body context | Records each command of a body, with its result, and each nested call, as the steps of the run entry | The context a body receives, which emits the commands |
| Batch | Runs a batch whose steps are `call` steps with `with` and `as`, resolving `${name.path}` from the results named so far | `when`, `each` and `fail`, run by the script runner of the engine, like a command step of a procedure |
| Transaction | Nothing: a batch is a sequence of calls | The one transaction of an action or of a batch, and its rollback when a call is refused |

A step of a batch given to the package that is not a `call` with `with` and `as` is refused with `invalid_script_step`; the engine runs such a batch through its script runner instead. In a batch run by the package, a placeholder `${name.path}` whose first segment is not an `as` name already set is refused with `unknown_reference`; a placeholder that is not a path, such as `${now()}`, is passed on unchanged to the called action.

**Export.** The export of an action to an AI tool maps its `id` to the tool name, with the slash replaced by a hyphen (`scflow/create_actor` gives `scflow-create_actor`), because AI clients accept only letters, digits, `_` and `-` in a tool name, and a hyphen never appears in an identifier, so the mapping goes back. `title`, `description` and `parameters` are kept as they are, `kind: read` gives `readOnlyHint` and `destructive` gives `destructiveHint`. An action whose `exposure` is `hidden` is not exported.

**Run log.** The run entries follow the [run log](meta-model.md#action): `parameters` and `result` are in the canonical form of JSON, and the `error` of a refused call is the code of its exception. A call refused by its parameters is recorded too, with the parameters it was given.

*Exceptions.*

| exception | thrown when |
| --- | --- |
| `invalid_parameters` | the parameters break the JSON Schema of the action, or a `ref` matches no instance or several |
| `unknown_action` | an id names no action of the registry |
| `duplicate_name` | an action is registered with the id of another one |
| `constraint_violation` | an action is registered with an id that is not a namespace, a slash and a name, both identifiers, or with `parameters` that are not a valid JSON Schema object |
| `invalid_script_step` | a step of a batch is not a `call` with only `with` and `as`, or a batch has `parameters` |
| `unknown_reference` | a placeholder of a batch names an `as` name that is not set yet |

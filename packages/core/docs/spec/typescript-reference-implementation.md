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
| `canImport`         | whether the import is possible overall. Special case: `locator` and `importedLocator` name the same dataset — `canImport` reflects that, and every other field below is null or empty.       |
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
**Creating an import.** Will create a new import for the imported dataset, assigning a namespace and copying all the content. Nothing is done if the dataset is already imported. An exception is thrown if any issue described in `checkImport` is encountered. Returns the new or existing import.

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
**Realigning an import.** Realigning an existing import is a multi-step operation as it may imply an upgrade and a refresh (see [Import](meta-model.md#import)).

For the upgrade part (see `@scfloworg/core`'s `docs/model-upgrade.md`) the first step is to obtain an upgrade locator; there is no need to populate it as for an upgrade after a model change — it is already populated with the new versions of the schema from the dataset. This upgrade locator can then be used to upgrade the dataset with `checkUpgrade` and `upgradeDataset` (see `@scfloworg/core`'s `docs/model-upgrade.md`).

**Creating an import upgrade locator.** Access the dataset in the import and copy its current model with the namespace into a temporary dataset, collect the changes to the model adding the namespace, and return it as an upgrade locator. This upgrade dataset also keeps track of the namespace, so `upgradeDataset` will also align the model version of the import, marking it ready for refresh.

Upgrade is not necessary if the model version of the imported dataset did not change; in that case an empty string is returned.

```ts
function createImportUpgradeLocator(locator: string, importKey: Key): Promise<string>
```

*Exceptions.*

| exception                   | thrown when                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `unknown_persistent_format` | `locator` or the locator in the import format prefix has no registered Persistence Interface |
| `dataset_not_found`         | `locator` or the locator in the import does not resolve to an existing dataset              |
| `key_not_found`             | Import does not exist                                                                        |

---
To refresh an import the dataset must have been upgraded first. This is checked by comparing the model version of the import and of the imported dataset.

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
| `import_not_upgraded`       | The import model version does not match the import dataset                                  |

## Persistence Interface

*Definition.*

The contract a [Persistent Format](meta-model.md#persistent-formats) implements so the modelling language can run against it: the storage-side counterpart of the TypeScript API.

The interface is deliberately low-level, raw storage of instances by key. Command processing and schema processing are generic, written once above it, so a new format only stores instances; a `schema`, `scalar_type` or `import` is an ordinary instance to it.

A format provides:
- its `name`, the locator prefix;
- the dataset lifecycle: create, read and patch the scalar properties, delete;
- instance storage by key, generic over every schema, with the property roles it may act on;
- an area and the built-in dataset of that area;
- optionally a write `lock` and support for transactions.

The contract is stated by the doc comments of `PersistenceInterface` in `@scfloworg/core` (`src/types.ts`), and the rules of locators and areas by its `docs/formats.md`.

# Datasets, schemas and the built-in dataset

A dataset is the unit of persistence: it can be moved, copied or dumped as a
whole. It holds two parts:

- the **modelling part**: the modules it uses (see Modules of a dataset below),
  and, until the built-in path is removed, schemas and scalar types of its own;
- the **data part**: every other instance, its imports included.

Each dataset has one `dataset` instance, a singleton, which is also a command
target (see The `dataset` instance below).

| Property | Meaning |
| --- | --- |
| `name` | Identifier; the only property an `update` may change |
| `model_major_version`, `model_minor_version` | Versions of the modelling part |
| `data_major_version`, `data_minor_version` | Versions of the data part |
| `created_at`, `updated_at` | Instants (`date_time`) maintained by the engine |
| `model_only` | Marks a library dataset: schemas and scalar types, no data |
| `schemas`, `scalar_types` | The schemas and scalar types owned by the dataset |
| `modules` | The modules the dataset uses: `{module, version, digest}` each, `[]` when none |
| `imports` | The names of the dataset's imports |

- Minor versions increase on every change of their part. A major version is
  bumped on purpose, with `bumpMajorVersions`, and resets its minor to `0`.
- An instance has its schema in a module the dataset uses, in the dataset, in the
  meta-model or in the built-in dataset of its area. Its relations point to
  instances of the same dataset, imported ones included.
- The meta-schemas `schema`, `scalar_type` and `dataset` are known to `core`; they
  need no declaration.

## The `dataset` instance

`runCommand` and `runScript` accept `dataset` as a target for `query` and
`update`. A rename goes through the ordinary command path, so it joins
transactions and can be reverted.

- `query` returns one instance in `after`: the dataset's transient form, equal to
  `queryDataset(locator)`. `filters` apply to that instance (one that does not
  match returns nothing), `result` shapes the answer, and a non-empty `namespace`
  is refused.
- `update` with `input: { name }` renames the dataset; `filters` are optional. The
  name must satisfy the `identifier` scalar type of the dataset's model, which
  the built-in dataset of the format supplies (see the doc comment of
  `resolveType`); otherwise the command fails with `constraint_violation`.
- `model_major_version`, `model_minor_version`, `data_major_version`,
  `data_minor_version`, `created_at`, `updated_at`, `model_only`, `schemas`,
  `scalar_types`, `modules` and `imports` are maintained by the engine or by a model upgrade: an `update`
  carrying one fails with `constraint_violation` naming the property. A key that
  is not a property of `dataset` is ignored, as elsewhere.
- `create` and `delete` fail with `constraint_violation`: `initDataset` and
  `restoreDataset` create a dataset, `deleteDataset` removes it.
- A rename that changes the name is a change of the data part: it increments
  `data_minor_version` and records `updated_at`. A rename to the current name
  changes nothing.
- Inside an `ApiSession` transaction, a rename joins the transaction's changes and
  can be reverted like any other change; outside a transaction it commits
  immediately. A rename is not reported to `subscribeObservable`.
- The engine calls `updateDataset(rest, patch)` of the format with `name`,
  `data_minor_version` and `updated_at`; the persistence interface has no other
  primitive for it.
- The transient form carries `imports`, the relation to the dataset's `import`
  instances, as an array of names. The built-in dataset never appears there: it
  is a virtual overlay, not a standing import.

## Lifecycle

```ts
initDataset(locator, name, options?: { modules?: ModuleManifest[] }): Promise<TransientValue>
queryDataset(locator): Promise<TransientValue>           // null when nothing is there
bumpMajorVersions(locator, bumpModel: boolean, bumpData: boolean): Promise<TransientValue>
deleteDataset(locator): Promise<TransientValue>          // returns the dataset as it was
dumpDataset(locator, format: "json" | "yaml"): Promise<string>
restoreDataset(locator, dump: string, format: "json" | "yaml"): Promise<RestoreResult>
// RestoreResult = { dataset, pendingRealignment }
```

- `initDataset` creates an empty dataset: versions at `0`, no instance, no import,
  and the modules of `options` embedded with it. It fails with
  `dataset_already_exists` when the locator is taken, and creates nothing when
  the modules do not build together (see Modules of a dataset).
- `queryDataset` is the one function that answers a missing dataset instead of
  failing, so it is how to test whether a locator resolves.
- A dump holds the model and the data of the dataset, in a form that does not
  depend on its format: a dump written from a dataset in one format restores into
  any other. `restoreDataset` creates a new dataset like `initDataset` does.
- A dump holds every schema the dataset defines, and its modules in two sections
  shaped as those of a [project file](spec/project-file.md): `modules`, each
  entry by module key with its `version` and `digest`, and `model`, each manifest
  embedded whole. The data of the schemas of a module is under their qualified
  names. A dump that does not parse is refused with `invalid_dump`.
- `restoreDataset` embeds the modules of the dump again. It refuses with
  `invalid_dump`, creating nothing, a manifest missing from `model`, invalid, or
  at another version than its entry, and the snapshot of a published module that
  does not match its digest. A local module is editable, so its digest is
  computed again. A dump with no `modules` section restores with no module.
- `restoreDataset` creates the extension instance (see [authoring.md](authoring.md),
  Extensions) that a restored instance lacks, from the defaults, as an upgrade
  does. It applies to a dump written before a schema became an extension of the
  schema of its instances, in the dataset or in its built-in. The extension
  instances the dump holds are left as they are, and the versions of the dump are
  kept.
- Everything else (a missing dataset, a missing format) fails with
  `dataset_not_found` or `unknown_persistent_format`.

## Schemas and the built-in dataset

A dataset keeps the schemas and scalar types it defines itself. It also sees the
schemas of the **built-in dataset** of its area.

- The built-in dataset is an ordinary dataset at `builtinRestFor(rest)`, one per
  area, and it is a library: schemas and scalar types only. The host creates it
  with `initDataset` before any other dataset of the area.
- Every read of a model sees the built-in schemas and scalar types as if they were
  the dataset's own, with no prefix: `describe`, `query` of `schema` or
  `scalar_type`, and every command. The overlay is computed at read time, and
  nothing of it is copied or stored. When both define a name, the dataset's own
  wins.
- A new dataset therefore stores no schema of its own, yet already reads those of
  its built-in.
- `dumpDataset` does not write the built-in schemas. It writes an `import` entry
  with `namespace: ""` that names the built-in schemas the data relies on, and
  `restoreDataset` rebuilds the overlay from the built-in dataset of the target
  area. Each restored instance of a built-in schema is checked against its
  current definition, and a restore fails with `incompatible_upgrade`, creating
  nothing, when one cannot take it.
- An instance whose schema exists nowhere is **dormant**: it is kept as stored,
  queries and commands do not see it, a dump writes it back unchanged, and it
  becomes ordinary again when its schema appears.
- The built-in dataset can declare the standard string types `date`, `date_time`,
  `time`, `identifier`, `email`, `uuid`, `duration` and `markdown` with their
  patterns. A type that no dataset declares falls back to a placeholder of `core`
  with an empty pattern.

### Changing the built-in dataset

The host changes the built-in dataset through the upgrade protocol (see
[model-upgrade.md](model-upgrade.md)), usually from the schemas that its plugins
contribute. Every dataset of the area sees the change at once.

- `core` does not propagate an incompatible change. Before upgrading the built-in,
  the host runs `checkUpgrade(locator, upgrade)` against each open dataset of the
  area, and refuses the change when one cannot take it.
- The version numbers of a built-in assembled at run time say nothing about its
  content: a dump writes them as `0` and ignores them on restore.

## Modules of a dataset

A dataset lists the [modules](modules.md) it uses, and embeds each manifest, so
a dataset read alone knows its model. The rules are in the specification:
[Dataset](spec/meta-model.md#dataset).

```ts
import { initDataset, readModuleManifest, runCommand } from "@scfloworg/core";

await initDataset("js:plant", "plant", { modules: [readModuleManifest(scflowYaml)] });
await runCommand("js:plant", { create: "scflow.actor", input: { name: "acme" } });
```

- `modules` of the dataset lists `{module, version, digest}` for each module, in
  the order given. The **digest** is `sha256:` followed by the hexadecimal
  SHA-256 of the canonical JSON of the manifest, as `validateModuleManifest`
  returns it: keys sorted, no white space. `moduleDigest(manifest)` computes it.
- The modules are put together as a module set (see [modules.md](modules.md)):
  two versions of one module fail with `duplicate_name`, two modules with one
  namespace with `namespace_conflict`, and a name that does not resolve fails as
  in a module set.
- A command names a schema of a module by its qualified name, `scflow.actor`. A
  short name resolves in `mcl:core` only, so `actor` fails with
  `unknown_schema`. The schemas and scalar types of a module are stored under
  their qualified names, and the standard scalar types of `mcl:core` apply with
  their patterns.
- A relation with an `inverse_name` generates its inverse on its target, as in a
  model upgrade. When the target belongs to another module, the inverse is
  qualified by the namespace of the declaring module, `carbon.emissions`, and
  `inverse_is_mandatory` fails with `constraint_violation`.
- The facets of the modules the dataset uses add their properties to their
  targets (see [modules.md](modules.md), Facets); a dataset without the module of
  a facet sees the target bare. A dump holds the instances of a facet under the
  facet's qualified name.
- A schema the dataset defines itself, or reads from its built-in dataset, keeps
  its short name and wins over a module on a name collision. This older path
  stays until the built-in dataset is removed.
- A format stores each manifest as an instance of `module`, by module key, and
  the list as the `modules` property of the dataset.
- Changing the modules of a dataset, apart from a local module, goes through a
  model upgrade (see [model-upgrade.md](model-upgrade.md)).

### Local modules

A local module, `local:<name>`, holds the schemas of one project. It is embedded
in the dataset like any module, is in no catalogue, and stays editable.

```ts
setLocalModule(locator, manifest): Promise<TransientValue>   // the dataset, as queryDataset gives it
```

- `setLocalModule` adds the local module, or replaces the one with its name. The
  instances already stored are checked against the new schemas: a property they
  lack takes its default, and `data_minor_version` is bumped when one is
  backfilled. Observers get a reset.
- It fails with `incompatible_upgrade`, changing nothing, when a stored instance
  cannot take the change (a new mandatory relation, a value that breaks a new
  constraint) or when a schema that has instances leaves the module.
- It fails with `constraint_violation` for a module that is not local: a
  published module changes through a model upgrade.
- A local module edited by hand in a dump is accepted on restore, with its new
  digest.

## Imports

An import copies the data of another dataset into this one, under a namespace
that prefixes the keys of the copies, and keeps track of it so that it can be
refreshed. It covers data only: the schemas come from the modules, and the
modules of the imported dataset join those of the dataset. The rules are in the
specification: [Import](spec/meta-model.md#import) and
[API Import](spec/typescript-reference-implementation.md#api-import).

```ts
checkImport(locator, importedLocator): Promise<CheckImportResult>
createImport(locator, importedLocator): Promise<TransientValue>   // the import
refreshImport(locator, importKey): Promise<RefreshResult>
removeImport(locator, importKey): Promise<TransientValue>         // the removed import
```

- `createImport` copies the instances of the schemas of the modules of the
  imported dataset. The name of the import is the name of that dataset, and its
  namespace that name and a dot, `suppliers.`; a name already taken gets a
  suffix, `suppliers_2`. Every key a copy holds, its own and those of its
  relations, embedded instances included, is prefixed. Instances of schemas the
  imported dataset defines itself, or reads from its built-in, are not copied.
- The import records `name`, `locator`, `namespace`, the data versions of the
  imported dataset and `caching_policy`, always `full` here. It is an instance of
  `import`, keyed by its name: a `query` reads it, a `create` fails with
  `import_cannot_be_created` and an `update` or `delete` with
  `constraint_violation`.
- The imports of the imported dataset are flattened: each one the dataset does
  not hold yet becomes an import of its own, with its instances, keeping its
  namespace when it is free; one it already holds is not copied again, and the
  references to it are rewritten to its namespace here. Its caching policy is
  aligned to the weakest.
- `checkImport` reports `canImport: false` for a dataset imported into itself
  (every other field is then `null` or empty), a back loop (`backImport`), an
  import already there at other data versions (`existingImport`), a nested
  import both hold at other data versions, and modules that cannot join: two
  versions of one module, or a set that does not build. `createImport` then
  fails with `cannot_import`. An import already there at the same versions is
  returned as it is.
- Imported instances are read-only. A command reaches the dataset's own
  instances by default; a `query` with `namespace: "suppliers."` reaches the
  instances of that import, and `namespace: "*"` every instance. Any other
  command with a namespace fails with `constraint_violation`, as does a
  namespace no import uses. An own instance may hold a relation to an imported
  one. The values of the facets of an imported instance are copied with it, and
  are read-only too.
- `refreshImport` copies the instances added since, overwrites the changed ones
  and deletes the removed ones, and reports them in `added`, `before`/`after`
  and `removed`. A relation of an own instance to a removed one is cleared, and
  that instance reported in `updated-before`/`updated-after`. A module the
  imported dataset uses at another version than the dataset fails with
  `import_not_upgraded`: the dataset upgrades first. A module it does not use
  yet joins it. The import records the data versions it reached.
- `removeImport` deletes the import and its instances, and clears the relations
  of own instances to them; the modules it brought stay. An unknown import fails
  with `key_not_found`.
- `createImport`, a `refreshImport` that changes something, and `removeImport`
  bump `data_minor_version` and send observers a reset. The imported dataset is
  read without its lock.

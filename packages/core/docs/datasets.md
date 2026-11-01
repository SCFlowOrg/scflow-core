# Datasets, schemas and the built-in dataset

A dataset is the unit of persistence: it can be moved, copied or dumped as a
whole. It holds two parts:

- the **modelling part**: schemas and scalar types;
- the **data part**: every other instance.

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

- Minor versions increase on every change of their part. A major version is
  bumped on purpose, with `bumpMajorVersions`, and resets its minor to `0`.
- An instance has its schema in the dataset, in the meta-model or in the built-in
  dataset of its area. Its relations point to instances of the same dataset.
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
  `data_minor_version`, `created_at`, `updated_at`, `model_only`, `schemas` and
  `scalar_types` are maintained by the engine or by a model upgrade: an `update`
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
  instances, as an array of names. It is always `[]`: the built-in dataset is a
  virtual overlay, not a standing import.

## Lifecycle

```ts
initDataset(locator, name): Promise<TransientValue>
queryDataset(locator): Promise<TransientValue>           // null when nothing is there
bumpMajorVersions(locator, bumpModel: boolean, bumpData: boolean): Promise<TransientValue>
deleteDataset(locator): Promise<TransientValue>          // returns the dataset as it was
dumpDataset(locator, format: "json" | "yaml"): Promise<string>
restoreDataset(locator, dump: string, format: "json" | "yaml"): Promise<RestoreResult>
// RestoreResult = { dataset, pendingRealignment }
```

- `initDataset` creates an empty dataset: versions at `0`, no instance, no import.
  It fails with `dataset_already_exists` when the locator is taken.
- `queryDataset` is the one function that answers a missing dataset instead of
  failing, so it is how to test whether a locator resolves.
- A dump holds the model and the data of the dataset, in a form that does not
  depend on its format: a dump written from a dataset in one format restores into
  any other. `restoreDataset` creates a new dataset like `initDataset` does.
- A dump holds every schema the dataset defines. A dump that does not parse is
  refused with `invalid_dump`.
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

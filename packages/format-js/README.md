# @scfloworg/format-js

The `js` persistent format: an in-memory `PersistenceInterface` implementation for `@scfloworg/core`, backed by plain JS objects. Its contract is the doc comments of `PersistenceInterface` in `@scfloworg/core`; this README is the only description of the `js` format itself.

Datasets are not persistent across process restarts, so the format serves tests, the REPL and applications that build their datasets at startup. An area's built-in dataset on the Node entry point is the one exception (see below).

## Start

```ts
import { registerPersistentFormat, initDataset, runCommand } from "@scfloworg/core";
import { jsFormat } from "@scfloworg/format-js";

registerPersistentFormat(jsFormat);
await initDataset("js:app/demo", "Demo");
```

The doc comments of `createJsPersistenceInterface`, `jsFormat` and `format` give the contract of each export.

## Entry points

- `@scfloworg/format-js`: the Node entry point. It adds the YAML fallback for an area's built-in dataset.
- `@scfloworg/format-js/browser`: the bundler-safe entry point. Nothing it imports touches `node:fs` or `js-yaml`. A static import of `node:fs/promises` breaks any browser bundle that loads it, even when unused, which is why there are two entry points.

Both export `createJsPersistenceInterface(name = "js")`, the shared `jsFormat` instance and `format`, an alias of `jsFormat` under the name a `--format-module` loader reads. `createJsPersistenceInterface` gives an isolated registry, which suits test isolation; `jsFormat` is the registry shared by a process.

## Locator

`js:<area>/<localRest>`. `area` is the part of `rest` before its last `/`; `localRest` names the dataset in the in-memory registry and is otherwise an arbitrary string. Two locators with the same `rest` address the same dataset for the lifetime of the interface instance.

## Storage

Each dataset holds its own properties, one `Map<key, instance>` per schema (`schema` and `scalar_type` included, with no special case) and one id counter per schema. Every read and write deep-copies through a JSON round-trip, so callers may mutate what they receive and no two calls return aliased objects.

The format generates no id: `@scfloworg/core` supplies the key of every instance, a uuid for a schema that is not `shared_by_name`. `getInstance` returns `null` for a missing key, because `@scfloworg/core` relies on a null read for dangling relations and cascade deletion; `deleteInstance` throws `key_not_found`. The interface declares `supportsTransactions: true`: only this process mutates an in-memory dataset.

## Area and built-in dataset

`areaOf(rest)` and `builtinRestFor(rest)` both return the area, so the bare area is the rest of the area's built-in dataset. A dataset created in memory at that rest is the built-in dataset.

- **Node entry point**: when no dataset exists in memory at the area, the area is read as the path of a YAML file holding a `dumpDataset` dump. Only `dataset`, `schemas` and `scalar_types` are read, because a built-in dataset holds a model only. A missing, unreadable or malformed file means no dataset. The file is read on every call and never cached, so an edit on disk shows on the next call. A built-in model is built as an ordinary `model_only` dataset and written to that path with `dumpDataset`.
- **Browser entry point**: no file is read. A built-in rest answers "no dataset" until a dataset is created there in memory.

A dataset resolved from the YAML file is read-only: `updateDataset`, `putInstance`, `deleteInstance` and `deleteDataset` look at the in-memory registry only and throw `dataset_not_found` for it, and `createDataset` throws `dataset_already_exists` when the file occupies the path.

## Concurrency

`lock(rest)` chains each caller behind the previous one on a promise queue kept per `rest`, and resolves to the function that releases it. Callers of one `rest` are served in arrival order, callers of different rests never wait for each other, and releasing twice frees nothing more than the first call did. No file or inter-process mechanism is involved, because one process holds every dataset of an interface instance. `@scfloworg/core` takes the lock around each command and transaction.

## Public surface

`createJsPersistenceInterface`, `jsFormat` and `format` on each entry point. `src/inMemory.ts` and `src/areaYaml.ts` are internal.

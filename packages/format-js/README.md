# @scfloworg/format-js

The `js` persistent format: an in-memory `PersistenceInterface` implementation for `@scfloworg/core`, backed by plain JS objects. Its contract is the doc comments of `PersistenceInterface` in `@scfloworg/core`; this README is the only description of the `js` format itself.

Datasets are not persistent across process restarts, so the format serves tests, the REPL and applications that build their datasets at startup. An area's built-in dataset on the Node entry point is the one exception (see below).

## Start

```ts
import { createEngine } from "@scfloworg/core";
import { jsFormat } from "@scfloworg/format-js";

const engine = createEngine({ formats: [jsFormat] });
await engine.initDataset("js:app/demo", "Demo");
```

The doc comments of `createJsPersistenceInterface`, `jsFormat` and `format` give the contract of each export.

## Entry points

- `@scfloworg/format-js`: the Node entry point.
- `@scfloworg/format-js/browser`: the bundler-safe entry point. Nothing it imports touches `node:fs` or `js-yaml`. A static import of `node:fs/promises` breaks any browser bundle that loads it, even when unused, which is why there are two entry points.

Both export `createJsPersistenceInterface(name = "js")`, the shared `jsFormat` instance and `format`, an alias of `jsFormat` under the name a `--format-module` loader reads. `createJsPersistenceInterface` gives an isolated registry, which suits test isolation; `jsFormat` is the registry shared by a process.

## Locator

`js:<area>/<localRest>`. `area` is the part of `rest` before its last `/`; `localRest` names the dataset in the in-memory registry and is otherwise an arbitrary string. Two locators with the same `rest` address the same dataset for the lifetime of the interface instance.

## Storage

Each dataset holds its own properties, one `Map<key, instance>` per schema (`schema` and `scalar_type` included, with no special case) and one id counter per schema. Every read and write deep-copies through a JSON round-trip, so callers may mutate what they receive and no two calls return aliased objects.

The format generates no id: `@scfloworg/core` supplies the key of every instance, a uuid for a schema that is not `shared_by_name`. `getInstance` returns `null` for a missing key, because `@scfloworg/core` relies on a null read for dangling relations and cascade deletion; `deleteInstance` throws `key_not_found`. The interface declares `supportsTransactions: true`: only this process mutates an in-memory dataset.

## Concurrency

`lock(rest)` chains each caller behind the previous one on a promise queue kept per `rest`, and resolves to the function that releases it. Callers of one `rest` are served in arrival order, callers of different rests never wait for each other, and releasing twice frees nothing more than the first call did. No file or inter-process mechanism is involved, because one process holds every dataset of an interface instance. `@scfloworg/core` takes the lock around each command and transaction.

## Public surface

`createJsPersistenceInterface`, `jsFormat` and `format` on each entry point. `src/inMemory.ts` and `src/areaYaml.ts` are internal.

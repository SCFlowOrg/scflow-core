# Locators and persistent formats

A **locator** designates one dataset: `<format-name>:<rest>`, split on the first
`:`. `format-name` picks the persistent format; `rest` means whatever that
format decides (a file path, a connection string, an in-memory name).

- Every function of the API that reaches a dataset takes a `locator`.
- `createEngine({ formats })` makes an engine with its formats (see Engines below).
- A locator whose format the engine does not hold fails with `unknown_persistent_format`.
- `core` depends on no format. A format implements `PersistenceInterface`, and
  `core` runs the whole command language on top of it.
- A format stores the modules of a dataset as it stores any instance: each
  manifest as an instance of `module`, by module key, and their list as the
  `modules` property that `updateDataset` gives it. The instances of a schema of
  a module are stored under its qualified name, such as `scflow.actor`, and an
  import as an instance of `import`. Imported instances are ordinary instances
  whose keys start with the namespace of their import.
- A format stores an instance under the key `core` gives it and generates no key
  itself: the `id` of an instance of a schema that is not `shared_by_name` is a uuid
  that `core` generates, or that the `create` supplies.

## Engines

`createEngine({ formats })` returns an `Engine`: the functions of the API that
take a locator, bound to the formats given at creation instead of the global
registry.

```ts
import { createEngine } from "@scfloworg/core";
import { createJsPersistenceInterface } from "@scfloworg/format-js";

const engine = createEngine({ formats: [createJsPersistenceInterface()] });
await engine.initDataset("js:plant", "plant");
const session = engine.createApiSession();
```

- An engine has `initDataset`, `queryDataset`, `bumpMajorVersions`,
  `deleteDataset`, `dumpDataset`, `restoreDataset`, `setLocalModule`, the
  functions of imports and of model upgrade, `runCommand`, `runScript`,
  `createScriptSession`, `createApiSession` and `subscribeObservable`. Each
  behaves as the free function of the same name, and `formats` lists the
  formats of the engine.
- The formats of an engine are fixed for its life. A locator whose format the
  engine does not hold fails with `unknown_persistent_format`, and two formats
  with one name fail with `duplicate_name` at creation.
- Two engines share nothing: neither the formats, so two instances of the `js`
  format named `js` hold two separate sets of datasets, nor the listeners of
  `subscribeObservable`.
- `@scfloworg/core/testing` holds free functions over a registry of its own, for
  tests only.

A property of a map type (see [multilingual.md](multilingual.md)) reaches a format
as an ordinary object, and a format that does not interpret it stores it as such.
The `js` format keeps it as is; the README of each format states what it does with a
localized `display_name`.

## The `js` format

`@scfloworg/format-js` implements the `js` format in memory: nothing is written
to disk, and a dataset lives as long as the process. Its entry points, locator
form and concurrency are described in the
[README of `@scfloworg/format-js`](../../format-js/README.md).

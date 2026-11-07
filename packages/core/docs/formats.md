# Locators and persistent formats

A **locator** designates one dataset: `<format-name>:<rest>`, split on the first
`:`. `format-name` picks the persistent format; `rest` means whatever that
format decides (a file path, a connection string, an in-memory name).

- Every function of the API that reaches a dataset takes a `locator`.
- `registerPersistentFormat(impl)` registers a format under `impl.name`, once and
  before any of its locators is used. A second registration under the same name
  replaces the first.
- A locator whose format is not registered fails with `unknown_persistent_format`.
- A format has **areas**: the place its datasets are attached to (a vault, a
  database, a running application). `areaOf(rest)` is the format's own rule to find
  it, and `builtinRestFor(rest)` names the built-in dataset of that area (see
  [datasets.md](datasets.md), Schemas and the built-in dataset).
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

A property of a map type (see [multilingual.md](multilingual.md)) reaches a format
as an ordinary object, and a format that does not interpret it stores it as such.
The `js` format keeps it as is; the README of each format states what it does with a
localized `display_name`.

## The `js` format

`@scfloworg/format-js` implements the `js` format in memory: nothing is written
to disk, and a dataset lives as long as the process. Its entry points, locator
form, built-in dataset and concurrency are described in the
[README of `@scfloworg/format-js`](../../format-js/README.md).

# Limitations

- **Imports are always `full`.** `createImport` gives every import the caching
  policy `full`, and a dump writes every imported instance; `partial` and `none`
  are kept when a flattened import carries them, but change nothing yet.
- **No `import` relation on instances.** An imported instance is told by the
  namespace that starts its key; the virtual relation of an instance to its
  import is not generated yet.
- **Refresh overwrites.** `refreshImport` applies every change of the imported
  dataset and clears the relations of own instances to removed ones, mandatory
  ones included; it leaves no review to the host before it writes.
- **Published modules are not upgraded.** The modules of a dataset are set by
  `initDataset`, a restore or an import; only a local module changes afterwards.
- **Embedded schemas are not command targets.** An embedded schema is a data shape
  inside its owner; a command addressed to it fails with `unknown_schema`.
- **Unknown input keys are ignored.** A key of a `create` or `update` `input` that
  is not a property of the schema is dropped, not refused.
- **`mandatory` on a scalar is not enforced.** Instance validation checks
  `mandatory` on relations only, so a text operation can empty a `mandatory`
  `string`.
- **Text operations are narrow.** They apply to single-valued `string` properties
  only: no array and no regular expression. An `update` writes each matched
  instance before it processes the next, so a refusal on a later instance leaves
  the earlier ones written.
- **Map types are narrow.** A map holds scalar values under string-based keys: no
  relation, array or nested map, no `default_value`. The engine has no current
  language, no source language and no detection of a translation made stale by a
  change of the source; the reader chooses the language.
- **A script session from `createScriptSession` loads the model once**, when it
  opens. A schema added later through an upgrade locator is not visible to it. A
  script session opened from an `ApiSession` revalidates the model on each `run`.
- **A same-name rename bumps versions through scripts.** A rename of a dataset to
  its current name changes nothing through `runCommand`, but through `runScript` or
  a `ScriptSession` it still bumps `data_minor_version` and `updated_at`.
- **`restoreDataset` validates the dump's structure only.** It checks that the dump
  has the `dataset`, `schemas`, `scalar_types` and `data` shape of `dumpDataset`; it
  does not run schema processing or instance validation again over the dumped
  entities. It creates the extension instances they lack.
- **An extension instance is stored apart.** The instances of an extension schema
  are stored under its name, so a persistent format lists them, a dump holds them
  and a transaction delta records them; a command never returns them. An instance
  written outside the engine with no extension instance reads without the
  properties of its extensions: only an upgrade or a `restoreDataset` creates the
  missing ones, from the defaults.
- **A model upgrade is classified conservatively.** A property whose `type` or
  array-ness changes is incompatible outright, even when every stored value would
  still fit, as in a relation retargeted so that every existing reference still
  resolves.

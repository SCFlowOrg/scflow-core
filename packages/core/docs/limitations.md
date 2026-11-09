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
- **A module upgrade runs when the host asks.** `upgradeModule` carries a dataset
  to a newer version of a module; `@scfloworg/core` compares no versions or digests
  when a dataset opens, which is the host's part. On a format without transactions
  the declared rules are not checked by `upgradeModule`: nothing could undo the
  upgrade once a rule is found broken.
- **Rules of a facet are not evaluated.** `checks` and `unique` declared on a
  facet are accepted and ignored.
- **Rule paths do not cross virtual relations.** A path in a rule or a filter
  crosses declared single-valued relations; a generated one reads as no value.
- **Rules are evaluated in memory.** A breach is found by reading the instances of
  the schemas concerned; no persistent format implements a rule natively yet.
- **A default across a relation is not backfilled.** A property added by an
  upgrade whose `default_value` crosses a relation fails to resolve on the
  existing instances.
- **The write limit holds in the context of an action only.** A command run
  outside an action is not refused yet, so it may write any schema and any facet.
- **Singletons are seeded when a dataset is created.** A singleton schema added
  to a module by a later upgrade gets no instance.
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
  relation, array or nested map. The engine has no current
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
  entities.
- **A model upgrade is classified conservatively.** A property whose `type` or
  array-ness changes is incompatible outright, even when every stored value would
  still fit, as in a relation retargeted so that every existing reference still
  resolves.

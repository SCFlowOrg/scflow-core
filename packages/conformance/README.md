# @scfloworg/conformance

A vitest suite, exported as a function, that any `PersistenceInterface` implementation runs against itself to prove it supports the Model Command Language. It is built from the worked command examples of the CORE `model` document, the `person`, `task_status`, `task` and `comment` "tasks-demo" model.

## Run it for a new format

```ts
import { runConformanceSuite } from "@scfloworg/conformance";
import { createJsPersistenceInterface } from "@scfloworg/format-js";

runConformanceSuite(createJsPersistenceInterface(), "js");
```

1. Add `@scfloworg/conformance` and `@scfloworg/core` as dependencies of the format package. A format implemented outside this repo references them through a `file:` path to this checkout, which resolves against the built `dist/` of each package, so build the repo first.
2. Call `runConformanceSuite(implementation, prefix)` from a `*.test.ts` file of the format package, as `packages/format-js/tests/format-js.test.ts` does. The suite registers the implementation under `prefix`, which becomes the locator prefix of its test datasets.
3. Run the tests. Each test runs against a freshly initialized dataset: the full create, query, update, delete and script flow, plus a set of documented exception cases.

The suite also holds the cases of modules and names: a `module.yaml` read as an instance of the `module` schema, `mcl:core` embedded, namespace conflicts, and how short and qualified names resolve. They use no dataset, so they give the same result for every format. The cases of the modules of a dataset and of imports do use datasets: modules embedded with their digest, commands by qualified name, a dump and its restore, local modules, and `checkImport`, `createImport`, `refreshImport` and `removeImport`. The cases of a module upgrade check `upgradeModule` of a session: a compatible change, a hand-edited snapshot, refusals, and, on a format with transactions, migrations in version order and their rollback.

The cases of declared rules use a module, `acme:net`, with one schema per rule: `checks` with `require` and with `exists`, a `unique` group, `acyclic`, `set_once` and `on_delete: confirm` with the `cascade` of a delete, checked by a standalone command, at the end of a transaction and by an upgrade that is refused with the instances at fault. They also cover paths on the right of a filter, `subset_of`, defaults across relations, procedures (`runProcedure`) and the declared forms of a migration, applied by `upgradeModule` of a session.

A format that provides the optional `lock(rest)` of the persistence interface also runs a lock case: a second holder waits for the first, two sessions writing at once lose no version increment, and the lock is released after a failed command and after a rolled-back transaction. The case is skipped for a format without `lock`.

## Actions

`runActionConformanceSuite(impl)` holds the cases of the action contract that need no dataset: the check of parameters and the resolution of `ref`, the registry, the run log in canonical JSON, the batches of calls with `${name.path}`, and the export to AI tools. An implementation of the neutral action package runs it against itself, as `packages/actions/tests/conformance.test.ts` does; the suite states the shape it uses in `ActionImplementation`, so it does not depend on `@scfloworg/actions`.

`@scfloworg/repl-conformance` runs the same kind of check through the REPL's command-block parser.

## Sample projects

`samples/project-file` holds sample projects in both shapes of the [project file](../core/docs/spec/project-file.md), with unknown sections. Every implementation reads them and writes them back without loss.

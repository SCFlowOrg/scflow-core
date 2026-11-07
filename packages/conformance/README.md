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

The suite also holds the cases of modules and names: a `module.yaml` read as an instance of the `module` schema, `mcl:core` embedded, namespace conflicts, and how short and qualified names resolve. They use no dataset, so they give the same result for every format.

A format that provides the optional `lock(rest)` of the persistence interface also runs a lock case: a second holder waits for the first, two sessions writing at once lose no version increment, and the lock is released after a failed command and after a rolled-back transaction. The case is skipped for a format without `lock`.

`@scfloworg/repl-conformance` runs the same kind of check through the REPL's command-block parser.

## Sample projects

`samples/project-file` holds sample projects in both shapes of the [project file](../core/docs/spec/project-file.md), with unknown sections. Every implementation reads them and writes them back without loss.

# @scfloworg/repl-conformance

A REPL-level, format-agnostic vitest suite. `@scfloworg/conformance` proves an implementation supports the command language by calling `runCommand` directly against structured `Command` objects; this package instead runs each fixture's commands as raw YAML *text* through `@scfloworg/repl`'s `runCommandBlock` — the same command-block parsing and validation path (`resolveCommandForm`'s unknown-key rejection included) a human typing at the REPL prompt goes through.

## Usage

```ts
import { runReplConformanceSuite } from "@scfloworg/repl-conformance";
import { createJsPersistenceInterface } from "@scfloworg/format-js";

runReplConformanceSuite(createJsPersistenceInterface("js-repl-conformance"), "js-repl-conformance");
```

Call it from a `*.test.ts` file in the format package being tested (see `packages/format-js/tests/repl-conformance.test.ts`). The second argument doubles as the locator prefix `initDataset`/`registerPersistentFormat` use — give it a value unique to this test file/process, not necessarily the format's own name. Two registrations of the same name in one process silently repoint the second one's dataset state onto the first's; `packages/repl/tests/repl.test.ts` registers its own private `"repltest"` js instance for the same reason.

## Fixtures

Each `fixtures/*.yaml` file is one scenario:

```yaml
name: a human-readable description, used as the test's `it` name

seed:                      # optional — raw scalar_type/schema description lists, applied before any commands run
  schemas: [...]

commands:
  - as: found               # optional — names this command's result, same as the command language's `as`
    run: |                   # raw YAML text, exactly as typed at the `run` prompt
      kind: query
      schema: task
      filters:
        title: t3
    expectError: some_code   # optional — this command must fail with an error containing this string; omit for a command that must succeed

expect:                    # optional — checked once every command has run
  - path: found.after.0.title   # dot-path into the session's named results (`r` is always the last command's implicit result)
    equals: t3
  - path: found.after
    length: 1
```

Add a new fixture file for a new scenario rather than a new hand-written test — every format package's own test file picks it up automatically, with no changes needed there.

Fixtures directly under `fixtures/` run as plain `it`s. A fixture placed in a subfolder instead (`fixtures/inverse-relations/one-to-many.yaml`) is nested under a `describe` block named after that folder (`inverse-relations`), so a related group of fixtures can be run on its own — `vitest -t inverse-relations`, or an IDE's "run this describe block" — without touching the loose fixtures at the root. Subfolders are for grouping only; they don't change a fixture's own shape, and nesting deeper than one level works the same way (the `describe` label is the fixture's full directory path relative to `fixtures/`, `/`-separated). Keep a fixture at the root rather than inventing a one-off folder for it — folders are worth it once there are a few related scenarios to group, not before.

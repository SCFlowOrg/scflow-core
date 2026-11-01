# Business model packages

How to write the business part of a plugin built on `core-plugin`. The UI
part (plugin orchestrator, `ui.json`, table generation) is documented in the
plugin workspace (`PLUGIN-STRUCTURE.md`).

## Principles

- A business package (`<name>-core`) is **pure**: no shell, no kernel, no
  React, no `ui.json`.
- It receives everything through **injection**: a `MclAccess` and a locator.
- It imports only **types** from `@scfloworg/core`. The single MCL engine
  lives in `core-plugin`.
- It never imports `core-plugin` or `@scfloworg/core-plugin-core` at runtime;
  only its tests use `@scfloworg/core-plugin-core/testing`.

## Contents

```
<name>-core/
  package.json        typed exports
  schemas.yaml        the MCL schemas (source of truth of the model)
  index.ts            exports the schemas + the business functions
  tests/              bun test, using createTestDocument
```

## Schemas (`schemas.yaml`)

```yaml
schemas:
  - name: task
    is_root: true
    ui_access: editable
    properties:
      - name: title
        type: string
        mandatory: true
      - name: done
        type: boolean
        default_value: false
```

All MCL constraints are available: `ui_access`, `mandatory`,
`default_value`, `is_array`, `min_length`/`max_length`, relations
(`owner`, `inverse_name`, `inverse_is_array`), scalar types (`enum`,
`pattern`, `minimum`, `maximum`, `date`, `email`, `uuid`, `markdown`…).
Full reference: `@scfloworg/core` → `docs/mcl.md`.

The YAML is loaded as data and re-exported:

```ts
import schemas from "./schemas.yaml";
export const SCHEMAS = schemas;
```

When the package is published, compile the YAML to `.ts`/`.json` at build
time so it stays consumable everywhere. The YAML remains the source.

Schema names are global: they are all registered in the shared built-in
`js:app`, and a name already registered by another plugin is refused.
Prefix them when a clash is likely.

## Business functions

Each function takes a `MclAccess` and a locator as parameters:

```ts
import type { MclAccess } from "@scfloworg/core";

export async function addTask(mcl: MclAccess, locator: string, input: { title: string }) {
  const { after } = await mcl.runCommand(locator, { kind: "create", schema: "task", input });
  return after[0];
}
```

- Writes are accepted only on open documents; the built-in is read-only.
- Inside the app, calls made from a handler join the document's open
  transaction, so they are undoable as one step.

## Model actions

A business package can export **actions**: `ModelActionDefinition` values
(type from `@scfloworg/core`, documented in its `docs/actions.md`) that UIs and
AI assistants list and run. The package exports them as data and stays pure;
the host registers them on the runtime.

```ts
// business package
export const ACTIONS = [addTaskAction];

// host
runtime.registerModelActions(ACTIONS);
runtime.getModelActions();                       // what a UI or an assistant offers
const id = await runtime.runModelAction<string>(docId, "tasks/add_task", { title: "A" });
```

- Registering an id again replaces the previous action.
- `runModelAction` throws a `CoreAccessError` with code `unknown_action` or
  `document_not_open`. It does not validate `params` against the action's
  `parameters`.
- Called while the document has an open transaction (a handler of the shell),
  the action joins it: the caller commits or rolls back, and the whole action is
  one step of the caller's undo unit.
- Called with no open transaction, the action runs in a transaction of its own
  labelled with its `title`: a failure rolls back every command it ran, and
  success commits and notifies the `onChange` listeners. No delta is returned,
  so run the action from a handler to make it undoable.
- An action declared `kind: "read"` runs outside any transaction, whether or not
  the document has one open: `runModelAction` neither begins, commits nor rolls
  back, notifies no `onChange` listener and returns the result of `execute`. An
  error is rethrown with the document history untouched. The action only reads.

## Tests

```ts
import { createTestDocument } from "@scfloworg/core-plugin-core/testing";

const { mcl, locator } = await createTestDocument(SCHEMAS);
await addTask(mcl, locator, { title: "A" });
const { after } = await mcl.runCommand(locator, { kind: "query", schema: "task" });
```

`createTestDocument` builds a real in-memory runtime with the given schemas
and one open document, reached through the same filtered `MclAccess` the
plugin hands out. `runtime.history` (begin / prepare / commit / rollback /
revert) is available to test undo/redo.

## What the runtime provides to the model

| Mechanism | Role |
|---|---|
| `registerSchemas(pluginId, schemas)` | publishes schemas into the shared built-in `js:app` (clash detection) |
| one dataset per document | `js:app/<docId>` |
| `mcl` | filtered `MclAccess`: open documents writable, built-in read-only |
| `locatorOf(docId)` / `isOpen(docId)` | locator resolution |
| `onChange(docId, fn)` | notification after every commit |
| undo/redo | `ApiSession` transactions mapped onto the document history |
| `registerModelActions` / `getModelActions` / `runModelAction` | registry and execution of the package's actions on an open document |

## Checklist

1. `schemas.yaml` + `index.ts` + `package.json`.
2. Business functions with injected `MclAccess`.
3. Tests with `createTestDocument` (`bun test`).

## Rules

- No import of the kernel, the shell, React or `core-plugin`.
- Types only from `@scfloworg/core`.
- State changes only through `mcl` on an open document.

# The workspace

A workspace holds the documents of a host, over an [environment](../../environment/docs/environment.md) and the `file` format. It has no UI. The CLI and the MCP server each create one.

```ts
const file = createFileFormat({ sections });
const environment = createEnvironment({ formats: [file] });
environment.modules.install(tasksModule);

const workspace = createWorkspace({ environment, file });
const doc = await workspace.open("./lyon-plant");
await doc.run("tasks/create_task", { title: "Audit" });
await doc.undo();
await doc.save();
```

`file` must be one of the formats of `environment`, or `createWorkspace` fails with `unknown_format`. The sections of other owners are declared on the format, because it reads the file.

## Documents

| Member of a workspace | Does |
| --- | --- |
| `create({ path, modules, type, title, name? })` | Creates a document that uses `modules` and their dependencies. Nothing is on disk before `save` |
| `open(path, { readOnly? })` | Opens a project, or returns the document already open at `path` |
| `get(path)`, `list()` | The open documents |

A document is **read only** when the environment reports its dataset so, or when an embedded manifest does not match its digest. `handEdited` lists those modules; a local module is never in it, since it stays editable. On a read-only document, `undo`, `redo`, `begin`, `setSection` and `save` are refused with `read_only_document`, and an action that writes with `read_only_dataset`.

`save()` writes the document through the format. `close()` forgets it, and what was not saved is lost.

## Sections

`doc.type` and `doc.title` are the envelope. `doc.section(key)` reads any section, and `doc.setSection(key, value)` writes one. `modules`, `model` and `data` belong to the dataset, and writing them fails with `reserved_section`.

## Transactions

`doc.run(id, params)` runs one action in its own transaction, which is one undo step. `doc.transaction(label, async (tx) => { ... })` groups the `tx.run` calls in one, and rolls back when its function throws.

A host that drives its own transaction uses the phases directly, `doc.begin(label)`, `doc.prepare()`, `doc.commit()` and `doc.rollback()`. `commit` without `prepare` runs both.

- A second `begin`, and `undo`, `redo` or `save` during a transaction, fail with `transaction_open`.
- `prepare`, `commit` or `rollback` with no transaction fail with `no_transaction`.
- An action refused inside a transaction rolls all of it back, so the transaction is then closed.

## Undo

`doc.undo()` and `doc.redo()` give `false` when there is nothing to do. `doc.history()` gives the labels of both stacks, the next one last.

- A transaction that changed nothing adds no step, and a new step clears redo.
- The history keeps 50 steps, lives in memory, and only covers `data`: a section written by `setSection` has no undo. It survives `save`.
- A revert moves the data version, so the deltas lower in the stack look stale to the engine. The stack already guarantees that the data is in the state each delta expects, so the workspace gives each delta the current versions before reverting it.
- An undo refused by the engine keeps its step.

# Access by locator and sessions

## `MclAccess`

```ts
interface MclAccess {
  runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult>;
  runScript(locator: string, script: AuthoredScript): Promise<CommandResult>;
}
```

`MclAccess` is defined by `core`, as types only, for code that must run commands by
locator without embedding a copy of `core`.

- `core` does not implement it as a class. The free functions `runCommand` and
  `runScript`, and the `ApiSession` returned by `createApiSession()`, already have
  these signatures and can be used as an `MclAccess`.
- A host application that wants to restrict what its consumers reach implements
  `MclAccess` itself, for instance by refusing a locator that is not a dataset it
  has opened, then calls `core` underneath.
- Code that receives an `MclAccess` imports types from `@scfloworg/core` and never a
  value, so the build erases the import.
- A consumer receives an `MclAccess` and a locator as parameters. It knows no
  document and is testable with any implementation.

## Sessions and transactions

`createApiSession()` returns an `ApiSession`: the same `runCommand` and `runScript`
as the free functions, plus a cache of the models, a queue per locator, and
transactions. Like them, it refuses a write of data with `write_outside_action`.
Only `Engine.createActionSession()`, for the host that builds the context of an
action, gives a session that may write; a test imports `createApiSession` from
`@scfloworg/core/testing` instead (see Writes and actions in
`docs/spec/typescript-reference-implementation.md`).

```ts
interface ApiSession {
  runCommand(locator, command): Promise<CommandResult>   // same as MclAccess
  runScript(locator, script): Promise<CommandResult>     // same as MclAccess
  createScriptSession(locator): Promise<ScriptSession>
  invalidate(locator): void
  supportsTransactions(locator): Promise<boolean>
  beginTransaction(locator, label?): Promise<TransactionId>
  prepareTransaction(locator, id): Promise<{ changed: boolean; delta: Delta; versions: DatasetVersions }>
  commitTransaction(locator, id): Promise<void>
  rollbackTransaction(locator, id): Promise<void>
  revert(locator, delta): Promise<void>
  queryDataset(locator): Promise<TransientValue>
  dumpDataset(locator, format): Promise<string>
  deleteDataset(locator): Promise<TransientValue>
}
```

- **Cache.** A session loads the model of a locator on first use and keeps it,
  stamped with the model versions it was loaded under. Every `runCommand`,
  `runScript`, `ScriptSession.run` and `revert` first compares that pair with the
  dataset's current one and reloads the model when they differ, so a model change
  made by another session, caller or upgrade is seen by the next call, at the cost
  of one dataset read. A call on a locator the session never cached reads nothing
  extra. `invalidate(locator)` drops the cache and rolls back the open transaction
  of the locator.
- **Queue.** A session runs the operations of one locator one at a time, in call
  order; a failed operation does not stop the next. Operations on other locators do
  not wait. `queryDataset`, `dumpDataset` and `deleteDataset` are queued like the
  others, and the session's `deleteDataset` first rolls back the open transaction
  and drops the cache. The free functions join no queue: use the session's own
  methods when it is the session that owns the locator.
- **Write lock.** A format that provides the optional `lock(rest)` of
  `PersistenceInterface` serializes its writers across sessions and processes. Each
  command takes the lock, and a transaction takes it at its outermost
  `beginTransaction` and holds it until the outermost commit or the rollback
  (including a rollback made by `invalidate` or the session's `deleteDataset`), so
  the commands inside it do not take it again. The lock is released in a `finally`,
  and version bumps and the uniqueness check of a supplied `id` run under it. A
  format without `lock` supports one caller at a time.
- **Transaction.** One transaction groups any number of commands, scripts and
  `revert` calls on one locator into one atomic step. A locator has at most one open
  transaction per session. A `beginTransaction` while one is open returns the same
  id and deepens the nesting; only the outermost `commitTransaction` finalizes it,
  and on an unprepared transaction it runs both phases. `rollbackTransaction` at any
  depth discards everything back to the outermost `beginTransaction`: the dataset's
  four versions and `updated_at` return to their values at that point, because the
  engine bumps them outside the delta and a rolled-back transaction never took
  effect.
- **Two phases.** `prepareTransaction` is the failable phase of the outermost
  commit, accepted only at depth one (at depth two or more it fails with
  `transaction_not_outermost`). It computes the delta, the observable delta and the
  versions the locator will have once finalized, and returns
  `{ changed, delta, versions }`; the writes of the commands already reached
  storage as each ran. After it, only `commitTransaction`, which cannot fail, or
  `rollbackTransaction` is accepted; anything else fails with `transaction_prepared`.
  A caller that coordinates other participants prepares all of them, then commits
  all.
- **Delta and revert.** A delta is opaque, immutable and JSON-serializable: store it
  as is. It holds the instances the transaction touched, cascades and ownership
  included, and the versions the dataset has once the transaction is finalized.
  `revert(locator, delta)` applies the inverse inside the open transaction, so a
  transaction made of one `revert` yields the delta that redoes it. The caller owns
  the undo and redo stacks; the session keeps none. `revert` fails with
  `stale_delta` when the dataset's versions differ from those the delta embeds, so
  it must be the first change of its transaction. It also fails with `invalid_delta`
  for a value that is not a delta. A delta is meaningful only against the dataset it
  came from: `revert` checks the versions, not the identity of the dataset.
  `revert` writes the stored instances directly and never replays a command, so it
  neither re-validates against the current model nor re-triggers side effects. It is
  one data change, and moves the minor data version once; an empty delta changes
  nothing. The `label` of `beginTransaction` is informational and plays no role in
  nesting, delta or revert.
- Check `supportsTransactions(locator)` first: a format may not support
  transactions, and then every call commits on its own.
- **Observing.** A transaction's committed changes to `observable` schemas are
  delivered to the listeners of `subscribeObservable`: see
  [observability.md](observability.md).

```ts
const session = createApiSession();

const tx = await session.beginTransaction(doc, "add task");
try {
  await session.runCommand(doc, { kind: "create", schema: "task", input: { title: "Ship" } });
  const { changed, delta } = await session.prepareTransaction(doc, tx);
  await session.commitTransaction(doc, tx);
  if (changed) undoStack.push(delta);
} catch (error) {
  await session.rollbackTransaction(doc, tx);
  throw error;
}

// Undo: revert in a transaction of its own; its delta is the redo.
const undoTx = await session.beginTransaction(doc, "undo");
await session.revert(doc, undoStack.pop()!);
const redo = (await session.prepareTransaction(doc, undoTx)).delta;
await session.commitTransaction(doc, undoTx);
```

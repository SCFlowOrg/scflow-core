# The environment

An environment holds what the engine does not: the catalogue of modules with
their code, the formats, the open datasets, the context an action receives and
the transaction of one action. It is an API of the implementation, not a
definition of MCL: the rules of modules, datasets and actions are in the
specification ([Module](../../core/docs/spec/meta-model.md#module),
[Dataset](../../core/docs/spec/meta-model.md#dataset),
[Action](../../core/docs/spec/meta-model.md#action) and
[Model Upgrade](../../core/docs/spec/meta-model.md#model-upgrade)). This page
gives the rules of the environment itself.

```ts
import { createEnvironment } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";

const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
env.modules.install(scflowModule);             // a defineModule result
await env.modules.load("packages/carbon");      // a module package on disk

const dataset = await env.datasets.create({ modules: ["acme:carbon"] });
const { result } = await dataset.run("carbon/set_actor_emissions", { actor, co2: 12 });
```

Two environments share nothing: each has its own engine, made by
`createEngine` of `@scfloworg/core` with the formats it is given, its own
catalogue and its own open datasets, so a test gets an isolated environment.

## Formats

`createEnvironment({ formats })` takes the persistent formats of the
environment, fixed for its life. A locator whose format it does not hold fails
with `unknown_persistent_format`, and two formats with one name fail with
`duplicate_name`. `env.formats` lists them.

## The catalogue

`env.modules` holds **one active version of each module**, with its code,
because the bodies of actions exist in one version in a process.

```ts
env.modules.install(module: ModuleDefinition): InstalledModule
env.modules.load(path: string): Promise<InstalledModule>
env.modules.get(key: string): InstalledModule | undefined
env.modules.list(): readonly InstalledModule[]
```

- `install` takes the result of `defineModule` of `@scfloworg/module`, as a
  plugin imports it. It validates the manifest as an instance of `module` and
  checks the code against it, as `modules.load` does (`checkModuleCode` of
  `@scfloworg/module/code`).
- `load` reads the module of a folder with `modules.load` of
  `@scfloworg/module/host`, bundle check included, then installs it. It is for
  a host that reads modules from disk, such as the CLI or the MCP server.
  The entry `@scfloworg/environment/browser` gives the same `createEnvironment`
  for a host with no file system: nothing from Node is reached from it, and
  `load` fails with `constraint_violation`.
- `dataset.addModule(key)` adds an installed module and its missing
  dependencies to an open dataset, and gives the keys added. It is a model
  upgrade that writes no instance and records no delta (see
  [model-upgrade.md](../../core/docs/model-upgrade.md), Adding a module). Its
  actions run from then on. A module the dataset already uses, same version and
  digest, is left alone. It is refused on a read-only dataset, with
  `read_only_dataset`, and during a transaction, with `transaction_open`.
- An `InstalledModule` gives the validated `manifest`, its `key` and
  `version`, the body of each action by id in `actions`, and the body of
  each migration by version in `migrations`.
- Installing a module again with the same manifest, in canonical form, returns
  the module already installed. Another version, or the same version with
  another manifest, so another digest, fails
  with `duplicate_name`: an environment keeps one version for its life, and a
  new version needs a new environment.
- Two installed modules cannot declare one namespace: `namespace_conflict`.
  `mcl:core` is embedded in the engine and fails with `duplicate_name`, and a
  local module, which no catalogue holds, fails with `constraint_violation`.
- Dependencies are not checked at install, so modules install in any order.
  They are checked when a dataset uses the modules.

## Datasets

`env.datasets` creates, opens and restores datasets, and keeps those it has
open.

```ts
env.datasets.create({ modules, locator?, name? }): Promise<OpenDataset>
env.datasets.open(locator, { readOnly? }): Promise<OpenDataset>
env.datasets.restore(locator, dump, format, { readOnly? }): Promise<OpenDataset>
env.datasets.get(locator): OpenDataset | undefined
env.datasets.list(): readonly OpenDataset[]
```

- `create` creates an empty dataset that uses the installed modules named by
  key in `modules`, with their dependencies: a dependency not listed is added
  before the module that needs it. A module that is not installed fails with
  `key_not_found`. `mcl:core` is always there, so naming it changes nothing.
  The modules are embedded with the dataset (see `initDataset` in
  `@scfloworg/core`'s `docs/datasets.md`).
- Without a `locator`, `create` takes the first format of the environment and
  the first free rest of `dataset-1`, `dataset-2`, and so on. `name` defaults
  to `dataset`.
- `open` opens an existing dataset, compares each module it embeds with the
  catalogue and upgrades it (see Opening a dataset below). `restore` restores a
  dump, as `restoreDataset` does, then opens it. Opening a dataset already
  open, or being opened, returns the same `OpenDataset`, whatever the options.
- The ranges of versions of `dependencies` and `mcl` are not checked yet: the
  specification does not yet say what a range accepts.

### Opening a dataset

Each module of an open dataset has a state, from its embedded version and the
installed one. The installed module wins over the embedded snapshot: `open`
upgrades the dataset to it when it can, and a dataset whose modules are not all
at their installed version is read only.

| State before the upgrade | Embedded and installed | On open |
| --- | --- | --- |
| `current` | The same version and digest | Nothing to do |
| `local` | A local module, embedded and editable | Nothing to do |
| `outdated` | The installed version is newer | Upgraded, with its migrations |
| `changed` | The same version with another digest | Upgraded, with no migration |
| `missing` | The module is not installed | Read only |
| `ahead` | The installed version is older than the file | Read only |

- **Upgrade on open.** `open` upgrades each `outdated` or `changed` module with
  `upgradeModule` of `@scfloworg/core` (see its `docs/model-upgrade.md`), one by
  one in the order of the modules of the dataset, where a dependency comes
  before the module that needs it. Each module upgrades in one transaction:
  compatible changes are applied, then the migrations run, then the instances
  are checked against the installed schemas.
- **A refused upgrade refuses the opening**: `open` fails with the error of the
  upgrade, typically `incompatible_upgrade` or what a migration threw, and the
  dataset is not open. The modules upgraded before it stay upgraded, and that
  module is left as it was.
- **Read only on request.** `open(locator, { readOnly: true })` upgrades
  nothing: the modules keep their state, the data is read with the embedded
  schemas, and every action that writes is refused, whatever the states. It is
  how a host shows a dataset it cannot or will not upgrade.
- `OpenDataset.modules` lists `{ module, version, installed, state }` for each,
  after the upgrades, where `installed` is the installed version or `null`.
  `OpenDataset.upgrades` lists `{ module, from, to, migrations, changed }` for
  each module upgraded on open, in order. `readOnly` is `true` when the dataset
  was opened read only or when one module is not `current` or `local`.
- A read-only dataset runs `read` actions, answers queries and dumps; an action
  that writes fails with `read_only_dataset`.

### Migrations

The migrations of a module are listed in its manifest. The environment runs the
code a module has for a migration, by its version in `migrations` of
`defineModule`; a migration with no code is left to the engine, which applies
its declared form.

```ts
interface MigrationContext extends MclAccess {
  readonly locator: string;   // the dataset being upgraded
  readonly module: string;    // the module being upgraded
  readonly from: string;      // the version embedded before the upgrade
  readonly to: string;        // the version this migration reaches
}
// A migration body: (context: MigrationContext, params: undefined) => unknown
```

- A migration body runs inside the transaction of the upgrade, with the
  installed schemas: it reads the values stored for the embedded ones and
  writes the new ones. A value the installed schema no longer declares is
  dropped at the end of the upgrade.
- Its context is an `MclAccess` limited to the dataset: a command on another
  locator fails with `dataset_not_found`. It has no parameters and calls no
  action.
- When the body throws, the upgrade of its module is rolled back and `open`
  fails with that error.

## Running an action

```ts
dataset.run(id: string, params?: unknown): Promise<ActionOutcome>
// ActionOutcome = { result, changed, delta, entry }
```

- The actions of a dataset are those its modules declare with code, and those
  generated from their schemas (see Generated actions in the specification);
  a declared action takes the place of a generated one of the same id.
  `dataset.actions()` lists them. An id that matches none fails with
  `unknown_action`.
- **An action run on a dataset is one transaction**, which the environment
  opens: it begins a transaction labelled with the `title` of the action, runs
  the body, prepares and commits it, and returns the `result` of the body,
  whether the dataset `changed`, and the `delta` of the transaction (see
  `@scfloworg/core`'s `docs/sessions.md`), which a host keeps to undo it. When
  the body throws, the transaction is rolled back and the error is thrown as
  is.
- A `read` action runs in no transaction, and its `delta` is `null`. On a
  format that does not support transactions, every command of the body commits
  on its own, `delta` is `null`, and `changed` tells whether the data versions
  moved.
- The runs of one dataset take turns: a run begins when the one before it has
  settled, so two actions never share a transaction.
- **A host can group actions in one transaction** with `dataset.begin(label)`,
  then `dataset.prepare()`, which gives `{ changed, delta }`, and
  `dataset.commit()`, or `dataset.rollback()`. A `run` while one is open joins
  it, and its `delta` is `null`. An action refused inside it rolls the whole
  transaction back, since a transaction is all or nothing. `begin` on a dataset
  that has one open, or on a read-only dataset, is refused
  (`transaction_open`, `read_only_dataset`).
- `dataset.revert(delta)` applies the inverse of a delta inside the open
  transaction, as `revert` of `@scfloworg/core` does.
- A declaration with a `body` procedure and no code runs that procedure with
  `runProcedure` of `@scfloworg/core`. Its commands are held to the write limit
  of the action, and each `call` step goes through the registry, so its
  parameters are checked and it reaches only the module and its dependencies.
- The parameters are checked against `parameters` by `@scfloworg/actions`
  before the body runs, and each `ref` is resolved to a key: a breach fails with
  `invalid_parameters`. An action that declares no `parameters` receives what it
  is given.
- `entry` is the run entry of the call, with the commands and nested calls of
  the body as its steps.
- `dataset.deleteImpact(schema, filters)` gives what a delete would remove and
  what refuses it, without writing anything (see Impact of a delete in the
  specification).

## The context of an action

A body is a function `(context, params) => result`, sync or async. The
`ActionContext` it receives is the only way it reaches the engine, and it
carries the write access to its dataset.

```ts
interface ActionContext extends MclAccess {
  readonly locator: string;   // the dataset the action runs on
  readonly action: string;    // the id of the running action
  runCommand(locator, command): Promise<CommandResult>;
  runScript(locator, script): Promise<CommandResult>;
  call(id: string, params?: unknown): Promise<unknown>;
}
```

- It is an `MclAccess` (see `@scfloworg/core`'s `docs/sessions.md`) limited to
  one dataset: a command or a script on another locator fails with
  `dataset_not_found`. Its commands run in the transaction of the action.
- `call` runs another action by id in the same transaction and returns its
  result. An action calls only the actions of its own module and of its
  dependencies; any other id fails with `unknown_action`.
- Time and ids come from MCL: a body uses `${now()}` and the keys of the
  engine, and reads no clock (see the contract of a body in the
  specification). `runCommand` of the context resolves `${now()}` in the
  command it runs and records the command as the body emitted it.
- A command that writes beyond the limit of the action fails with
  `write_not_declared`: it writes only the schemas of its `writes`, which name
  schemas of its module, and a property of a facet only if that facet is in its
  `writes`. A `read` action writes nothing. Each step of a script is checked
  before the script runs.
- A write outside an action fails with `write_outside_action`: the context
  of an action is the only way to write.

## Queries and saving

```ts
dataset.query(command): Promise<CommandResult>
dataset.info(): Promise<TransientValue>       // the dataset, as queryDataset gives it
dataset.dump(format: "json" | "yaml"): Promise<string>
dataset.close(): Promise<void>
```

- `query` runs a query outside any action. Any other command fails with
  `write_outside_action`.
- `dump` writes the dataset with its modules embedded, as `dumpDataset` does,
  and `restore` reads it back in this environment or in another one.
- `close` forgets the dataset: a later `open` reads it again. It does not
  delete it.

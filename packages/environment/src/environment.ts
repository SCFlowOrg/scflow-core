/**
 * `createEnvironment`: an engine of its own over the formats it is given, the
 * catalogue, the open datasets, the context of an action and the transaction
 * of one action (see `docs/environment.md`).
 */
import {
  MCL_CORE_KEY,
  createEngine,
  isLocalModule,
  modelError,
  moduleDigest,
  canonicalParameters,
  checkActionWrite,
  createRefResolver,
  generatedActions,
  resolveClockPlaceholders,
  resolveCommandForm,
  runProcedure,
  type ApiSession,
  type AuthoredCommand,
  type AuthoredScript,
  type CommandResult,
  type DatasetModel,
  type DeleteImpact,
  type Delta,
  type Engine,
  type Filter,
  type MclAccess,
  type MigrationStep,
  type ModuleManifest,
  type PersistenceInterface,
  type Procedure,
  type TransactionId,
  type TransientObject,
  type TransientValue,
} from "@scfloworg/core";
import {
  createActionRegistry,
  type Action,
  type ActionRegistry,
  type JsonSchema,
  type RunEntry,
  type RunHost,
  type RunTrace,
} from "@scfloworg/actions";
import { createCatalogue, type InstalledModule, type ModuleCatalogue, type ModuleLoader } from "./catalogue.js";

/** What `createEnvironment` takes. */
export interface EnvironmentOptions {
  /** The persistent formats of the environment, fixed for its life. */
  formats: readonly PersistenceInterface[];
}

/** An environment: its formats, its catalogue and its datasets. */
export interface Environment {
  /** The formats of the environment, in the order given. */
  readonly formats: readonly PersistenceInterface[];
  /** The catalogue: one active version of each module, with its code. */
  readonly modules: ModuleCatalogue;
  /** The datasets the environment creates, opens and restores. */
  readonly datasets: DatasetRegistry;
}

/** What `datasets.create` takes. */
export interface CreateDatasetOptions {
  /** The keys of the installed modules the dataset uses; their dependencies are added. */
  modules: readonly string[];
  /** Where the dataset is created; by default the first free `dataset-<n>` of the first format. */
  locator?: string;
  /** The name of the dataset, `dataset` by default. */
  name?: string;
}

/** `env.datasets`: the datasets of an environment. */
export interface DatasetRegistry {
  /**
   * Creates an empty dataset that uses the modules of `options` and their
   * dependencies, embedded, and opens it. Fails with `key_not_found` for a
   * module that is not installed, and as `initDataset` does.
   */
  create(options: CreateDatasetOptions): Promise<OpenDataset>;
  /**
   * Opens the dataset at `locator`, or returns it when it is open, whatever
   * `options`. Unless `options.readOnly`, first upgrades each module whose
   * installed version is newer, or the same with another digest, one by one in
   * the order of the dataset's modules (see `docs/environment.md`, Opening a
   * dataset). Fails with `dataset_not_found`, and with the error of an upgrade
   * that is refused: the dataset is not opened then, and the modules upgraded
   * before stay upgraded.
   */
  open(locator: string, options?: OpenOptions): Promise<OpenDataset>;
  /** Restores a dump at `locator`, as `restoreDataset` does, and opens it as `open` does. */
  restore(
    locator: string,
    dump: string,
    format: DumpFormat,
    options?: OpenOptions,
  ): Promise<OpenDataset>;
  /** The open dataset at `locator`, or `undefined`. */
  get(locator: string): OpenDataset | undefined;
  /** The open datasets, in the order they were opened. */
  list(): readonly OpenDataset[];
}

/** What `datasets.open` and `datasets.restore` take. */
export interface OpenOptions {
  /** Opens the dataset read only: nothing is upgraded, and an action that writes is refused. */
  readOnly?: boolean;
}

/** A module upgraded when its dataset was opened. */
export interface ModuleUpgrade {
  readonly module: string;
  /** The version embedded before the upgrade. */
  readonly from: string;
  /** The version embedded now, the installed one. */
  readonly to: string;
  /** The `to` of each migration that ran, in order. */
  readonly migrations: readonly string[];
  /** Whether an instance changed. */
  readonly changed: boolean;
}

/** The format of a dump. */
export type DumpFormat = "json" | "yaml";

/** How the embedded version of a module stands against the installed one (see `docs/environment.md`, Opening a dataset). */
export type ModuleStateName = "current" | "local" | "missing" | "outdated" | "ahead" | "changed";

/** A module an open dataset uses. */
export interface ModuleState {
  readonly module: string;
  /** The version embedded in the dataset. */
  readonly version: string;
  /** The installed version, or `null` when the module is not installed or is local. */
  readonly installed: string | null;
  readonly state: ModuleStateName;
}

/** What `run` returns. */
export interface ActionOutcome {
  /** What the body returned. */
  readonly result: unknown;
  /** Whether the action changed the dataset. */
  readonly changed: boolean;
  /** The delta of the transaction, to undo it, or `null` for a run in no transaction. */
  readonly delta: Delta | null;
  /** The run entry of the call, with its commands and nested calls as steps. */
  readonly entry: RunEntry;
}

/** A dataset the environment has open. */
export interface OpenDataset {
  readonly locator: string;
  /** The modules the dataset uses, each with its state. */
  readonly modules: readonly ModuleState[];
  /** The modules upgraded when the dataset was opened, in order. */
  readonly upgrades: readonly ModuleUpgrade[];
  /**
   * Whether an action that writes is refused: the dataset was opened read
   * only, or a module is neither `current` nor `local`.
   */
  readonly readOnly: boolean;
  /**
   * Runs the action `id` with `params`, in one transaction unless it is a
   * `read` action. Fails with `unknown_action` for an action no module of the
   * dataset declares, with `invalid_parameters` for parameters that break its
   * JSON Schema, with `write_not_declared` for a write beyond its limit, with
   * `read_only_dataset` for an action that writes on a
   * read-only dataset, and with what the body throws, the transaction rolled
   * back.
   */
  run(id: string, params?: unknown): Promise<ActionOutcome>;
  /**
   * Opens a transaction that the next runs join, so that they are one step. A
   * joined run gives `changed: false` and `delta: null`: `prepare` tells for
   * all of them. Fails with `transaction_open` when one is open, and with
   * `read_only_dataset` on a read-only dataset.
   */
  begin(label?: string): Promise<void>;
  /** The failable phase of the open transaction. Fails with `no_transaction` when none is open. */
  prepare(): Promise<{ changed: boolean; delta: Delta }>;
  /** Finalizes the open transaction. Fails with `no_transaction` when none is open. */
  commit(): Promise<void>;
  /** Discards the open transaction. Fails with `no_transaction` when none is open. */
  rollback(): Promise<void>;
  /**
   * Adds the installed module `key` and its missing dependencies, as Adding a
   * module in Model Upgrade says, and gives the keys added: `[]` when the dataset
   * already uses them. Writes no instance and records no delta. `modules` and
   * `actions` then include them. Fails with `read_only_dataset`, with
   * `transaction_open` during a transaction, with `key_not_found` for a module
   * not installed, and as `addModule` of the engine does.
   */
  addModule(key: string): Promise<string[]>;
  /** Applies the inverse of `delta` in the open transaction, as `revert` of the engine does. */
  revert(delta: Delta): Promise<void>;
  /** The actions of the dataset, declared and generated, that it can run. */
  actions(): readonly Action<ActionContext>[];
  /**
   * What deleting the instances of `schema` matched by `filters` would remove
   * and what refuses it, without writing anything.
   */
  deleteImpact(schema: string, filters?: unknown): Promise<DeleteImpact>;
  /** Runs a command outside any action, for a read. A write is not refused yet (see `docs/environment.md`). */
  query(command: AuthoredCommand): Promise<CommandResult>;
  /** The dataset, as `queryDataset` gives it. */
  info(): Promise<TransientValue>;
  /** The dump of the dataset, with its modules embedded, as `dumpDataset` writes it. */
  dump(format: DumpFormat): Promise<string>;
  /** Forgets the dataset, without deleting it: a later `open` reads it again. */
  close(): Promise<void>;
}

/**
 * The context an action receives: an `MclAccess` limited to the dataset of the
 * action, inside its transaction, and the calls to other actions. It is the
 * only way a body reaches the engine.
 */
export interface ActionContext extends MclAccess {
  /** The locator of the dataset the action runs on. */
  readonly locator: string;
  /** The id of the running action. */
  readonly action: string;
  /** Runs a command on the dataset; another locator fails with `dataset_not_found`. */
  runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult>;
  /** Runs a script on the dataset; another locator fails with `dataset_not_found`. */
  runScript(locator: string, script: AuthoredScript): Promise<CommandResult>;
  /**
   * Runs the action `id` of the same module or of a dependency, in the same
   * transaction, its parameters checked, and returns its result. Any other id
   * fails with `unknown_action`.
   */
  call(id: string, params?: unknown): Promise<unknown>;
}

/** The body of an action, as the environment calls it. */
export type ActionBody = (context: ActionContext, params: unknown) => unknown;

/**
 * The context a migration receives: an `MclAccess` limited to the dataset it
 * upgrades, inside the transaction of the upgrade, with the installed schemas
 * of the module (see `docs/environment.md`, Migrations).
 */
export interface MigrationContext extends MclAccess {
  /** The locator of the dataset being upgraded. */
  readonly locator: string;
  /** The key of the module being upgraded. */
  readonly module: string;
  /** The version embedded before the upgrade. */
  readonly from: string;
  /** The version this migration reaches. */
  readonly to: string;
  /** Runs a command on the dataset; another locator fails with `dataset_not_found`. */
  runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult>;
  /** Runs a script on the dataset; another locator fails with `dataset_not_found`. */
  runScript(locator: string, script: AuthoredScript): Promise<CommandResult>;
}

/** The body of a migration, as the environment calls it: with no parameters. */
export type MigrationBody = (context: MigrationContext, params: undefined) => unknown;

/** What the environment knows of a registered action to run it. */
interface ActionLimit {
  /** The key of the module of the action. */
  readonly module: string;
  /** The canonical names of the schemas it writes; none for a `read` action. */
  readonly writes: ReadonlySet<string>;
  readonly title: string;
}

/** Creates an environment whose `modules.load` is `load`. Each entry of the package gives its own. */
export function createEnvironmentWith(options: EnvironmentOptions, load: ModuleLoader): Environment {
  const engine = createEngine({ formats: options.formats });
  const session = engine.createActionSession();
  const modules = createCatalogue(load);
  const open = new Map<string, OpenDataset>();
  // The openings under way, so that two calls for one locator upgrade it once.
  const opening = new Map<string, Promise<OpenDataset>>();

  const datasets: DatasetRegistry = {
    async create(create: CreateDatasetOptions): Promise<OpenDataset> {
      const manifests = closure(modules, create.modules);
      const locator = create.locator ?? (await freeLocator(engine));
      await engine.initDataset(locator, create.name ?? "dataset", { modules: manifests });
      return openAt(locator);
    },
    open: (locator, options) => openAt(locator, options),
    async restore(
      locator: string,
      dump: string,
      format: DumpFormat,
      options?: OpenOptions,
    ): Promise<OpenDataset> {
      await engine.restoreDataset(locator, dump, format);
      return openAt(locator, options);
    },
    get: (locator) => open.get(locator),
    list: () => [...open.values()],
  };

  function openAt(locator: string, options: OpenOptions = {}): Promise<OpenDataset> {
    const known = open.get(locator);
    if (known) return Promise.resolve(known);
    const pending = opening.get(locator);
    if (pending) return pending;
    const run = readAndUpgrade(locator, options.readOnly === true).finally(() =>
      opening.delete(locator),
    );
    opening.set(locator, run);
    return run;
  }

  async function readAndUpgrade(locator: string, readOnly: boolean): Promise<OpenDataset> {
    const read = async () => {
      const info = await session.queryDataset(locator);
      if (info === null) throw modelError("dataset_not_found", `no dataset at "${locator}"`);
      return moduleStates(modules, info as TransientObject);
    };
    let states = await read();
    const upgrades: ModuleUpgrade[] = [];
    if (!readOnly) {
      for (const state of states) {
        if (state.state !== "outdated" && state.state !== "changed") continue;
        const module = modules.get(state.module)!;
        const { from, to, migrations, changed } = await session.upgradeModule(
          locator,
          module.manifest,
          {
            migrate: (step) => runMigration(locator, module, step),
          },
        );
        upgrades.push(
          Object.freeze({
            module: module.key,
            from,
            to,
            migrations: Object.freeze([...migrations]),
            changed,
          }),
        );
      }
      if (upgrades.length > 0) states = await read();
    }
    const dataset = openDataset(
      locator,
      states,
      upgrades,
      readOnly,
      await session.datasetModel(locator),
    );
    open.set(locator, dataset);
    return dataset;
  }

  /** Runs the code of the migration `step` of `module`, if it has some, and tells whether it did. */
  async function runMigration(
    locator: string,
    module: InstalledModule,
    step: MigrationStep,
  ): Promise<boolean> {
    const body = module.migrations.get(step.to) as MigrationBody | undefined;
    if (!body) return false;
    const reach = (target: string) => {
      if (target !== locator)
        throw modelError(
          "dataset_not_found",
          `the migration of "${module.key}" to ${step.to} reaches only "${locator}", not "${target}"`,
        );
    };
    const context: MigrationContext = Object.freeze({
      locator,
      module: module.key,
      from: step.from,
      to: step.to,
      async runCommand(target: string, command: AuthoredCommand) {
        reach(target);
        return session.runCommand(locator, command);
      },
      async runScript(target: string, script: AuthoredScript) {
        reach(target);
        return session.runScript(locator, script);
      },
    });
    await body(context, undefined);
    return true;
  }

  function openDataset(
    locator: string,
    initialStates: ModuleState[],
    upgrades: ModuleUpgrade[],
    openedReadOnly: boolean,
    initialModel: DatasetModel | null,
  ): OpenDataset {
    // What the modules of the dataset decide, replaced when a module is added.
    let states = initialStates;
    let model = initialModel;
    const readOnly =
      openedReadOnly ||
      states.some((state) => state.state !== "current" && state.state !== "local");
    let { registry, limits } = buildRegistry(modules, states, model);
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    };

    let openTransaction: TransactionId | null = null;
    const requireTransaction = (): TransactionId => {
      if (openTransaction === null)
        throw modelError("no_transaction", `"${locator}" has no open transaction`);
      return openTransaction;
    };

    const limitOf = (id: string) => limits.get(id) as ActionLimit;
    const refResolverOf = (current: DatasetModel | null) =>
      current ? createRefResolver(current, (command) => session.runCommand(locator, command)) : undefined;
    let resolveRef = refResolverOf(model);

    function contextOf(trace: RunTrace): ActionContext {
      const limit = limitOf(trace.action);
      const reach = (target: string) => {
        if (target !== locator)
          throw modelError(
            "dataset_not_found",
            `the action "${trace.action}" reaches only "${locator}", not "${target}"`,
          );
      };
      const checkWrite = (command: AuthoredCommand) => {
        if (model) checkActionWrite(model, limit.module, limit.writes, command);
      };
      return Object.freeze({
        locator,
        action: trace.action,
        async runCommand(target: string, command: AuthoredCommand) {
          reach(target);
          checkWrite(command);
          // the run log keeps ${now()} as the body emitted it; only what runs reads the clock
          const result = await session.runCommand(locator, resolveClockPlaceholders(command));
          trace.command(command, result);
          return result;
        },
        async runScript(target: string, script: AuthoredScript) {
          reach(target);
          script.commands.forEach(checkWrite);
          const result = await session.runScript(locator, script);
          trace.command(script, result);
          return result;
        },
        async call(id: string, params?: unknown) {
          const callee = limits.get(id);
          const dependencies = model?.set.module(limit.module)?.manifest.dependencies ?? [];
          if (
            !callee ||
            (callee.module !== limit.module &&
              !dependencies.some((dependency) => dependency.module === callee.module))
          )
            throw modelError(
              "unknown_action",
              `"${trace.action}" cannot reach the action "${id}": it is not of its module or of a dependency`,
            );
          return trace.call(id, params);
        },
      });
    }

    const host: RunHost<ActionContext> = {
      context: contextOf,
      get resolveRef() {
        return resolveRef;
      },
    };

    async function addModule(key: string): Promise<string[]> {
      if (readOnly) throw modelError("read_only_dataset", `"${locator}" is read only: no module can be added`);
      if (openTransaction !== null)
        throw modelError("transaction_open", `"${locator}" has an open transaction: no module can be added`);
      const added = await session.addModule(locator, closure(modules, [key]));
      if (added.length === 0) return added;
      const info = (await session.queryDataset(locator)) as TransientObject;
      states = await moduleStates(modules, info);
      model = await session.datasetModel(locator);
      ({ registry, limits } = buildRegistry(modules, states, model));
      resolveRef = refResolverOf(model);
      return added;
    }

    async function run(id: string, params: unknown): Promise<ActionOutcome> {
      const action = registry.get(id);
      if (!action)
        throw modelError("unknown_action", `no module of "${locator}" runs the action "${id}"`);
      if (action.kind === "read") {
        const { result, entry } = await registry.run(id, params, host);
        return { result, changed: false, delta: null, entry };
      }
      if (readOnly)
        throw modelError(
          "read_only_dataset",
          `"${locator}" is open read only, so the action "${id}" cannot run: ${openedReadOnly ? "it was opened read only" : reasons(states)}`,
        );
      if (openTransaction !== null) {
        try {
          const { result, entry } = await registry.run(id, params, host);
          return { result, changed: false, delta: null, entry };
        } catch (error) {
          // A transaction is all or nothing: the writes of this action cannot be undone alone.
          await session.rollbackTransaction(locator, openTransaction);
          openTransaction = null;
          throw error;
        }
      }
      if (!(await session.supportsTransactions(locator))) {
        const before = await dataVersions();
        const { result, entry } = await registry.run(id, params, host);
        return { result, changed: (await dataVersions()) !== before, delta: null, entry };
      }
      const tx = await session.beginTransaction(locator, limitOf(id).title);
      try {
        const { result, entry } = await registry.run(id, params, host);
        const { changed, delta } = await session.prepareTransaction(locator, tx);
        await session.commitTransaction(locator, tx);
        return { result, changed, delta, entry };
      } catch (error) {
        await session.rollbackTransaction(locator, tx);
        throw error;
      }
    }

    async function dataVersions(): Promise<string> {
      const info = (await session.queryDataset(locator)) as TransientObject;
      return `${info.data_major_version}.${info.data_minor_version}`;
    }

    /** `query` only reads: the session may write, and a caller reaches it through actions alone. */
    function refuseWrite(command: AuthoredCommand): void {
      const { kind, schema } = resolveCommandForm(command) as unknown as { kind: string; schema: string };
      if (kind !== "query") throw modelError("write_outside_action", `a ${kind} of "${schema}" runs outside an action`);
    }

    const dataset: OpenDataset = Object.freeze({
      locator,
      get modules() {
        return Object.freeze(states);
      },
      upgrades: Object.freeze(upgrades),
      readOnly,
      addModule: (key: string) => inTurn(() => addModule(key)),
      run: (id: string, params?: unknown) => inTurn(() => run(id, params)),
      begin: (label?: string) =>
        inTurn(async () => {
          if (readOnly)
            throw modelError("read_only_dataset", `"${locator}" is read only: no transaction can open`);
          if (openTransaction !== null)
            throw modelError("transaction_open", `"${locator}" already has an open transaction`);
          openTransaction = await session.beginTransaction(locator, label);
        }),
      prepare: () =>
        inTurn(async () => {
          const { changed, delta } = await session.prepareTransaction(locator, requireTransaction());
          return { changed, delta };
        }),
      commit: () =>
        inTurn(async () => {
          await session.commitTransaction(locator, requireTransaction());
          openTransaction = null;
        }),
      rollback: () =>
        inTurn(async () => {
          await session.rollbackTransaction(locator, requireTransaction());
          openTransaction = null;
        }),
      revert: (delta: Delta) =>
        inTurn(async () => {
          requireTransaction();
          await session.revert(locator, delta);
        }),
      actions: () => registry.list(),
      deleteImpact: (schema: string, filters?: unknown) =>
        inTurn(() => session.deleteImpact(locator, schema, filters as Filter | undefined)),
      query: (command: AuthoredCommand) =>
        inTurn(() => {
          refuseWrite(command);
          return session.runCommand(locator, command);
        }),
      info: () => inTurn(() => session.queryDataset(locator)),
      dump: (format: DumpFormat) => inTurn(() => session.dumpDataset(locator, format)),
      close: () =>
        inTurn(async () => {
          if (open.get(locator) === dataset) open.delete(locator);
          session.invalidate(locator);
        }),
    });
    return dataset;
  }

  return Object.freeze({ formats: engine.formats, modules, datasets });
}

/** The `body` of a declaration when it is a procedure: a mapping with a list of commands. */
function procedureOf(body: unknown): Procedure | undefined {
  return body !== null &&
    typeof body === "object" &&
    Array.isArray((body as { commands?: unknown }).commands)
    ? (body as Procedure)
    : undefined;
}

/**
 * The registry of a dataset: the actions its modules declare with a body the
 * environment holds, and the actions generated from their schemas. A declared
 * action takes the place of a generated one of the same id. A declared action
 * runs its code, else its procedure, whose commands and calls go through the
 * context of the action: they keep its write limit, and each call goes through
 * the registry. A module the environment does not have runs no procedure.
 */
function buildRegistry(
  modules: ModuleCatalogue,
  states: readonly ModuleState[],
  model: DatasetModel | null,
): { registry: ActionRegistry<ActionContext>; limits: Map<string, ActionLimit> } {
  const registry = createActionRegistry<ActionContext>();
  const limits = new Map<string, ActionLimit>();
  if (!model) return { registry, limits };
  const canonicalWrites = (key: string, writes: unknown): string[] =>
    (Array.isArray(writes) ? (writes as string[]) : []).map(
      (name) => model.set.requireSchema(name, key).key,
    );
  for (const loaded of model.set.modules) {
    if (loaded.key === MCL_CORE_KEY) continue;
    const state = states.find((s) => s.module === loaded.key)?.state;
    const installed = states.some((s) => s.module === loaded.key && s.installed !== null)
      ? modules.get(loaded.key)
      : undefined;
    for (const declaration of loaded.actions.values()) {
      const id = declaration.id as string;
      const body = installed?.actions.get(id) as ActionBody | undefined;
      const procedure = state === "missing" ? undefined : procedureOf(declaration.body);
      if (!body && !procedure) continue;
      const writes = canonicalWrites(loaded.key, declaration.writes);
      const kind = declaration.kind === "read" ? "read" : "action";
      const title =
        typeof declaration.title === "string" && declaration.title !== "" ? declaration.title : id;
      const parameters = declaration.parameters ?? procedure?.parameters;
      registry.register({
        id,
        title,
        description:
          typeof declaration.description === "string" ? declaration.description : undefined,
        kind,
        destructive: declaration.destructive === true,
        exposure: declaration.exposure === "hidden" ? "hidden" : "visible",
        writes,
        ...(parameters === undefined || parameters === null || parameters === ""
          ? {}
          : { parameters: canonicalParameters(model, loaded.key, id, parameters) as JsonSchema }),
        run: (params, context) =>
          body
            ? body(context, params)
            : runProcedure(procedure as Procedure, params, {
                runCommand: (command) => context.runCommand(context.locator, command),
                call: (called, calledParams) => context.call(called, calledParams),
              }),
      });
      limits.set(id, { module: loaded.key, writes: new Set(kind === "read" ? [] : writes), title });
    }
    // a module the dataset embeds but the environment does not have stays out, as its declared actions do
    if (state === "missing" || state === "ahead") continue;
    for (const generated of generatedActions(model, loaded)) {
      if (loaded.actions.has(generated.id)) continue;
      registry.register(generated as unknown as Action<ActionContext>);
      limits.set(generated.id, {
        module: loaded.key,
        writes: new Set(generated.writes),
        title: generated.title,
      });
    }
  }
  return { registry, limits };
}

/**
 * The manifests of the modules named by `keys` and of their dependencies, each
 * dependency before the module that needs it. `mcl:core` is skipped; a module
 * that is not installed fails with `key_not_found`.
 */
function closure(modules: ModuleCatalogue, keys: readonly string[]): ModuleManifest[] {
  const ordered: ModuleManifest[] = [];
  const seen = new Set<string>();
  const visit = (key: string, neededBy?: string) => {
    if (key === MCL_CORE_KEY || seen.has(key)) return;
    seen.add(key);
    const module = modules.get(key);
    if (!module)
      throw modelError(
        "key_not_found",
        neededBy
          ? `"${neededBy}" depends on "${key}", which is not installed`
          : `"${key}" is not installed`,
      );
    for (const dependency of module.manifest.dependencies) visit(dependency.module, key);
    ordered.push(module.manifest);
  };
  for (const key of keys) visit(key);
  return ordered;
}

/** The first `<format>:dataset-<n>` of the first format of `engine` where no dataset is. */
async function freeLocator(engine: Engine): Promise<string> {
  const format = engine.formats[0];
  if (!format)
    throw modelError(
      "unknown_persistent_format",
      "the environment has no format to create a dataset in",
    );
  for (let n = 1; ; n++) {
    const locator = `${format.name}:dataset-${n}`;
    if ((await engine.queryDataset(locator)) === null) return locator;
  }
}

/** The state of each module a dataset embeds, against the catalogue. */
async function moduleStates(
  modules: ModuleCatalogue,
  info: TransientObject,
): Promise<ModuleState[]> {
  const entries = Array.isArray(info.modules) ? (info.modules as TransientObject[]) : [];
  return Promise.all(
    entries.map(async (entry) => {
      const key = String(entry.module);
      const version = String(entry.version);
      const state = (name: ModuleStateName, installed: string | null): ModuleState =>
        Object.freeze({ module: key, version, installed, state: name });
      if (isLocalModule(key)) return state("local", null);
      const installed = modules.get(key);
      if (!installed) return state("missing", null);
      const order = compareVersions(installed.version, version);
      if (order > 0) return state("outdated", installed.version);
      if (order < 0) return state("ahead", installed.version);
      const digest = await moduleDigest(installed.manifest);
      return state(digest === entry.digest ? "current" : "changed", installed.version);
    }),
  );
}

/** Why a dataset is read only, for a message. */
function reasons(states: readonly ModuleState[]): string {
  return states
    .filter((state) => state.state !== "current" && state.state !== "local")
    .map(
      (state) =>
        `"${state.module}" ${state.version} is ${state.state}${state.installed ? ` (installed: ${state.installed})` : ""}`,
    )
    .join("; ");
}

/** Compares two semantic versions `major.minor.patch`. */
function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

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
  type ApiSession,
  type AuthoredCommand,
  type AuthoredScript,
  type CommandResult,
  type Delta,
  type Engine,
  type MclAccess,
  type ModuleManifest,
  type PersistenceInterface,
  type TransientObject,
  type TransientValue,
} from "@scfloworg/core";
import { createCatalogue, type InstalledModule, type ModuleCatalogue } from "./catalogue.js";

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
  /** Opens the dataset at `locator`, or returns it when it is open. Fails with `dataset_not_found`. */
  open(locator: string): Promise<OpenDataset>;
  /** Restores a dump at `locator`, as `restoreDataset` does, and opens it. */
  restore(locator: string, dump: string, format: DumpFormat): Promise<OpenDataset>;
  /** The open dataset at `locator`, or `undefined`. */
  get(locator: string): OpenDataset | undefined;
  /** The open datasets, in the order they were opened. */
  list(): readonly OpenDataset[];
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
}

/** A dataset the environment has open. */
export interface OpenDataset {
  readonly locator: string;
  /** The modules the dataset uses, each with its state. */
  readonly modules: readonly ModuleState[];
  /** Whether a module is neither `current` nor `local`: an action that writes is then refused. */
  readonly readOnly: boolean;
  /**
   * Runs the action `id` with `params`, in one transaction unless it is a
   * `read` action. Fails with `unknown_action` for an action no module of the
   * dataset declares, with `read_only_dataset` for an action that writes on a
   * read-only dataset, and with what the body throws, the transaction rolled
   * back.
   */
  run(id: string, params?: unknown): Promise<ActionOutcome>;
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
   * transaction, and returns its result. Any other id fails with
   * `unknown_action`.
   */
  call(id: string, params?: unknown): Promise<unknown>;
}

/** The body of an action, as the environment calls it. */
export type ActionBody = (context: ActionContext, params: unknown) => unknown;

/** An action found in the modules of a dataset. */
interface FoundAction {
  readonly id: string;
  readonly module: InstalledModule;
  readonly title: string;
  readonly kind: string;
  readonly body: ActionBody;
}

/** Creates an environment over `formats`; it shares nothing with another one. Fails with `duplicate_name` for two formats of one name. */
export function createEnvironment(options: EnvironmentOptions): Environment {
  const engine = createEngine({ formats: options.formats });
  const session = engine.createApiSession();
  const modules = createCatalogue();
  const open = new Map<string, OpenDataset>();

  const datasets: DatasetRegistry = {
    async create(create: CreateDatasetOptions): Promise<OpenDataset> {
      const manifests = closure(modules, create.modules);
      const locator = create.locator ?? (await freeLocator(engine));
      await engine.initDataset(locator, create.name ?? "dataset", { modules: manifests });
      return openAt(locator);
    },
    open: (locator) => openAt(locator),
    async restore(locator: string, dump: string, format: DumpFormat): Promise<OpenDataset> {
      await engine.restoreDataset(locator, dump, format);
      return openAt(locator);
    },
    get: (locator) => open.get(locator),
    list: () => [...open.values()],
  };

  async function openAt(locator: string): Promise<OpenDataset> {
    const known = open.get(locator);
    if (known) return known;
    const info = await session.queryDataset(locator);
    if (info === null) throw modelError("dataset_not_found", `no dataset at "${locator}"`);
    const states = await moduleStates(modules, info as TransientObject);
    // Opened by a concurrent call while this one read the dataset.
    const raced = open.get(locator);
    if (raced) return raced;
    const dataset = openDataset(locator, states);
    open.set(locator, dataset);
    return dataset;
  }

  function openDataset(locator: string, states: ModuleState[]): OpenDataset {
    const readOnly = states.some((state) => state.state !== "current" && state.state !== "local");
    // The modules of the dataset whose code the environment runs.
    const usable = states
      .filter((state) => state.installed !== null)
      .map((state) => modules.get(state.module)!);
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    };

    function find(id: string, from?: InstalledModule): FoundAction {
      const namespace = id.slice(0, id.indexOf("/"));
      const module = usable.find((candidate) => candidate.manifest.namespace === namespace);
      const declaration = module?.manifest.actions.find((action) => action.id === id);
      if (!module || !declaration)
        throw modelError("unknown_action", `no module of "${locator}" declares the action "${id}"`);
      if (
        from &&
        module !== from &&
        !from.manifest.dependencies.some((dependency) => dependency.module === module.key)
      )
        throw modelError(
          "unknown_action",
          `"${id}" belongs to "${module.key}", which "${from.key}" does not depend on`,
        );
      const body = module.actions.get(id) as ActionBody | undefined;
      if (!body)
        throw modelError(
          "unknown_action",
          `"${id}" is a procedure, which the environment does not run yet`,
        );
      return {
        id,
        module,
        title:
          typeof declaration.title === "string" && declaration.title !== ""
            ? declaration.title
            : id,
        kind: typeof declaration.kind === "string" ? declaration.kind : "action",
        body,
      };
    }

    function contextOf(action: FoundAction): ActionContext {
      const reach = (target: string) => {
        if (target !== locator)
          throw modelError(
            "dataset_not_found",
            `the action "${action.id}" reaches only "${locator}", not "${target}"`,
          );
      };
      return Object.freeze({
        locator,
        action: action.id,
        async runCommand(target: string, command: AuthoredCommand) {
          reach(target);
          return session.runCommand(locator, command);
        },
        async runScript(target: string, script: AuthoredScript) {
          reach(target);
          return session.runScript(locator, script);
        },
        async call(id: string, params?: unknown) {
          const callee = find(id, action.module);
          return callee.body(contextOf(callee), params);
        },
      });
    }

    async function run(id: string, params: unknown): Promise<ActionOutcome> {
      const action = find(id);
      if (action.kind === "read")
        return {
          result: await action.body(contextOf(action), params),
          changed: false,
          delta: null,
        };
      if (readOnly)
        throw modelError(
          "read_only_dataset",
          `"${locator}" is open read only, so the action "${id}" cannot run: ${reasons(states)}`,
        );
      if (!(await session.supportsTransactions(locator))) {
        const before = await dataVersions();
        const result = await action.body(contextOf(action), params);
        return { result, changed: (await dataVersions()) !== before, delta: null };
      }
      const tx = await session.beginTransaction(locator, action.title);
      try {
        const result = await action.body(contextOf(action), params);
        const { changed, delta } = await session.prepareTransaction(locator, tx);
        await session.commitTransaction(locator, tx);
        return { result, changed, delta };
      } catch (error) {
        await session.rollbackTransaction(locator, tx);
        throw error;
      }
    }

    async function dataVersions(): Promise<string> {
      const info = (await session.queryDataset(locator)) as TransientObject;
      return `${info.data_major_version}.${info.data_minor_version}`;
    }

    const dataset: OpenDataset = Object.freeze({
      locator,
      modules: Object.freeze(states),
      readOnly,
      run: (id: string, params?: unknown) => inTurn(() => run(id, params)),
      query: (command: AuthoredCommand) => inTurn(() => session.runCommand(locator, command)),
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

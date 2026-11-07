/**
 * The catalogue of an environment: one active version of each module, with
 * its code (see `docs/environment.md`, The catalogue).
 */
import {
  MCL_CORE_KEY,
  isLocalModule,
  modelError,
  validateModuleManifest,
  type ModuleManifest,
} from "@scfloworg/core";
import type { ModuleBody, ModuleDefinition } from "@scfloworg/module";
import { checkModuleCode } from "@scfloworg/module/code";

/** A module of the catalogue: its validated manifest and its code. */
export interface InstalledModule {
  /** The key of the module, `publisher:module`. */
  readonly key: string;
  readonly version: string;
  /** The manifest, validated as an instance of `module`. */
  readonly manifest: ModuleManifest;
  /** The body of each action of the code, by action id. */
  readonly actions: ReadonlyMap<string, ModuleBody>;
  /** The body of each migration of the code, by the version it reaches. */
  readonly migrations: ReadonlyMap<string, ModuleBody>;
}

/** `env.modules`: the catalogue of an environment. */
export interface ModuleCatalogue {
  /**
   * Installs a module given by `defineModule` of `@scfloworg/module`: validates
   * its manifest and checks its code against it. Returns the module already
   * installed for the same module; fails with `duplicate_name` for another
   * version or digest of an installed module and for `mcl:core`, with
   * `namespace_conflict` for a namespace another module declares, with
   * `constraint_violation` for a local module, an invalid manifest or code that
   * does not match it.
   */
  install(module: ModuleDefinition): InstalledModule;
  /**
   * Loads the module of a folder with `modules.load` of
   * `@scfloworg/module/host`, bundle check included, then installs it. Fails
   * as `modules.load` and `install` do.
   */
  load(path: string): Promise<InstalledModule>;
  /** The installed module of `key`, or `undefined`. */
  get(key: string): InstalledModule | undefined;
  /** The installed modules, in the order of their installation. */
  list(): readonly InstalledModule[];
}

/** The code of a module, checked: its manifest and its bodies. */
interface CheckedModule {
  readonly manifest: ModuleManifest;
  readonly actions: ReadonlyMap<string, ModuleBody>;
  readonly migrations: ReadonlyMap<string, ModuleBody>;
}

export function createCatalogue(): ModuleCatalogue {
  const installed = new Map<string, InstalledModule>();

  function add(module: CheckedModule): InstalledModule {
    const { manifest } = module;
    const key = manifest.name;
    const form = canonical(manifest);
    if (key === MCL_CORE_KEY)
      throw modelError(
        "duplicate_name",
        `"${MCL_CORE_KEY}" is embedded in the engine and is not installed`,
      );
    if (isLocalModule(key))
      throw modelError(
        "constraint_violation",
        `"${key}" is a local module, which no catalogue holds`,
      );
    const existing = installed.get(key);
    if (existing) {
      if (canonical(existing.manifest) === form) return existing;
      throw modelError(
        "duplicate_name",
        `"${key}" ${existing.version} is installed: an environment holds one version of a module, ` +
          `so ${manifest.version}${manifest.version === existing.version ? " with another content" : ""} needs a new environment`,
      );
    }
    for (const other of installed.values()) {
      if (other.manifest.namespace === manifest.namespace)
        throw modelError(
          "namespace_conflict",
          `"${key}" and "${other.key}" both declare the namespace "${manifest.namespace}"`,
        );
    }
    const entry: InstalledModule = Object.freeze({
      key,
      version: manifest.version,
      manifest,
      actions: module.actions,
      migrations: module.migrations,
    });
    installed.set(key, entry);
    return entry;
  }

  return {
    install(module: ModuleDefinition): InstalledModule {
      const manifest = validateModuleManifest(module.manifest);
      const { actions, migrations } = checkModuleCode(manifest, { default: module });
      return add({ manifest, actions, migrations });
    },
    async load(path: string): Promise<InstalledModule> {
      // A dynamic import: the host entry reads files, and a browser bundle of
      // the environment that only installs never loads it.
      const { modules } = await import("@scfloworg/module/host");
      return add(await modules.load(path));
    },
    get: (key) => installed.get(key),
    list: () => [...installed.values()],
  };
}

/**
 * The canonical JSON of a value, keys sorted and no white space: the form the
 * digest of a manifest is computed from, so two manifests with one canonical
 * form have one digest.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

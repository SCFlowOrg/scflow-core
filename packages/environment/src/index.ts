/**
 * `@scfloworg/environment`: the catalogue of modules with their code, the
 * formats given at creation, the open datasets, the context of actions and the
 * transaction of one action (see `docs/environment.md`).
 */
import { createEnvironmentWith, type Environment, type EnvironmentOptions } from "./environment.js";

/** Creates an environment over `formats`; it shares nothing with another one. Fails with `duplicate_name` for two formats of one name. */
export function createEnvironment(options: EnvironmentOptions): Environment {
  return createEnvironmentWith(options, async (path) => {
    // A dynamic import: only a host that loads modules from disk pays for it.
    const { modules } = await import("@scfloworg/module/host");
    return modules.load(path);
  });
}

export type {
  ActionBody,
  ActionContext,
  ActionOutcome,
  CreateDatasetOptions,
  DatasetRegistry,
  DumpFormat,
  Environment,
  EnvironmentOptions,
  MigrationBody,
  MigrationContext,
  ModuleState,
  ModuleStateName,
  ModuleUpgrade,
  OpenDataset,
  OpenOptions,
} from "./environment.js";
export type { InstalledModule, ModuleCatalogue } from "./catalogue.js";
export type { Action, RunEntry } from "@scfloworg/actions";

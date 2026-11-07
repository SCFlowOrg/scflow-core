/**
 * `@scfloworg/environment`: the catalogue of modules with their code, the
 * formats given at creation, the open datasets, the context of actions and the
 * transaction of one action (see `docs/environment.md`).
 */
export { createEnvironment } from "./environment.js";
export type {
  ActionBody,
  ActionContext,
  ActionOutcome,
  CreateDatasetOptions,
  DatasetRegistry,
  DumpFormat,
  Environment,
  EnvironmentOptions,
  ModuleState,
  ModuleStateName,
  OpenDataset,
} from "./environment.js";
export type { InstalledModule, ModuleCatalogue } from "./catalogue.js";

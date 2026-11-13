/**
 * `@scfloworg/environment` for a host with no file system: the same
 * environment, whose modules are installed and never loaded from a folder.
 * Nothing from Node is reached from here.
 */
import { modelError } from "@scfloworg/core";
import { createEnvironmentWith, type Environment, type EnvironmentOptions } from "./environment.js";

export type * from "./index.js";

// Every export of the main entry but `createEnvironment`, which is defined
// below. They come from the modules that define them, never through
// `./index.js`: it holds the dynamic import of `@scfloworg/module/host`, which
// reaches Node. A test keeps the two entries equal.
export { MODULE_DOCS_SOURCE, createModuleDocsSource } from "./docs.js";
export {
  AUDIENCES as DOCS_AUDIENCES,
  DOCS_MANIFEST_FILE,
  DOCS_TOOL,
  buildManifest as buildDocsManifest,
  createCatalogue as createDocsCatalogue,
  createDocsTool,
  serializeManifest as serializeDocsManifest,
} from "@scfloworg/docs";
export { SKILL_TOOL, checkSkillCitations, citedActionIds, createSkillTool } from "./skills.js";

/** Creates an environment as `createEnvironment` does. `modules.load` fails with `constraint_violation`. */
export function createEnvironment(options: EnvironmentOptions): Environment {
  return createEnvironmentWith(options, async (path) => {
    throw modelError("constraint_violation", `Cannot load "${path}": this host has no file system, install the module`);
  });
}

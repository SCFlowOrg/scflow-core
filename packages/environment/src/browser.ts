/**
 * `@scfloworg/environment` for a host with no file system: the same
 * environment, whose modules are installed and never loaded from a folder.
 * Nothing from Node is reached from here.
 */
import { modelError } from "@scfloworg/core";
import { createEnvironmentWith, type Environment, type EnvironmentOptions } from "./environment.js";

export type * from "./index.js";

/** Creates an environment as `createEnvironment` does. `modules.load` fails with `constraint_violation`. */
export function createEnvironment(options: EnvironmentOptions): Environment {
  return createEnvironmentWith(options, async (path) => {
    throw modelError("constraint_violation", `Cannot load "${path}": this host has no file system, install the module`);
  });
}

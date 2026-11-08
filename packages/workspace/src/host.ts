/**
 * What a host that reads projects from disk starts with, the CLI and the MCP
 * server alike: an environment, the file format, a workspace, and the modules
 * of a folder.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createEnvironment, type Environment } from "@scfloworg/environment";
import { createFileFormat, type FileFormat } from "@scfloworg/format-file";
import type { SectionRegistry } from "@scfloworg/project-file";
import { createWorkspace, type Workspace } from "./index.js";

/** What `createProjectHost` takes. */
export interface ProjectHostOptions {
  /** A folder of modules: the folder of one, or a folder whose sub-folders each hold one. */
  modules?: string;
  /** The sections the owners of the host declare. */
  sections?: SectionRegistry;
}

/** A workspace with what it stands on. */
export interface ProjectHost {
  environment: Environment;
  file: FileFormat;
  workspace: Workspace;
}

const MANIFEST_FILE = "module.yaml";

async function moduleFolders(root: string): Promise<string[]> {
  if (existsSync(join(root, MANIFEST_FILE))) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, MANIFEST_FILE)))
    .map((entry) => join(root, entry.name))
    .sort();
}

/** Creates a host, with the modules of `options.modules` installed. Fails as `modules.load` does. */
export async function createProjectHost(options: ProjectHostOptions = {}): Promise<ProjectHost> {
  const file = createFileFormat({ sections: options.sections });
  const environment = createEnvironment({ formats: [file] });
  if (options.modules !== undefined) {
    for (const folder of await moduleFolders(options.modules)) await environment.modules.load(folder);
  }
  return { environment, file, workspace: createWorkspace({ environment, file }) };
}

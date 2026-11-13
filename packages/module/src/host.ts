/**
 * `modules.load(path)`: the module of a folder, for a host that reads modules
 * from disk (see `docs/module-packages.md`, Load a module).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { modelError, readModuleManifest, type ModuleManifest } from "@scfloworg/core";
import { checkModuleCode } from "./code.js";
import { checkBundle, formatFindings } from "./check.js";
import type { DocLoader, ModuleBody, SkillLoader } from "./index.js";

export { checkModuleCode };

/** The file of the manifest in the folder of a module package. */
export const MANIFEST_FILE = "module.yaml";
/** The file of the bundle in the folder of a module package. */
export const BUNDLE_FILE = join("dist", "module.js");

/** A module loaded from its folder. */
export interface ModulePackage {
  /** The folder of the module, as an absolute path. */
  readonly path: string;
  /** `module.yaml`, validated as an instance of `module`. */
  readonly manifest: ModuleManifest;
  /** The path of `dist/module.js`, or `null` for a module with no code. */
  readonly bundle: string | null;
  /** The body of each action of the code, by action id. */
  readonly actions: ReadonlyMap<string, ModuleBody>;
  /** The body of each migration of the code, by the version it reaches. */
  readonly migrations: ReadonlyMap<string, ModuleBody>;
  /** The loader of the Markdown body of each skill, by skill id. */
  readonly skills: ReadonlyMap<string, SkillLoader>;
  /** The loader of the Markdown body of each documentation topic, by the `file` of its entry in `docs`. */
  readonly docs: ReadonlyMap<string, DocLoader>;
}

/**
 * The loaders of the skill bodies of a module: those of the code when it has
 * code, else the files of its folder, read when a body is asked for. A file
 * that does not exist throws `constraint_violation`.
 */
export function skillLoaders(
  manifest: ModuleManifest,
  folder: string | null,
  fromCode: ReadonlyMap<string, string>,
): Map<string, SkillLoader> {
  const loaders = new Map<string, SkillLoader>();
  for (const skill of manifest.skills ?? []) {
    const body = fromCode.get(skill.id);
    if (body !== undefined) {
      loaders.set(skill.id, async () => body);
      continue;
    }
    const path = folder === null ? null : join(folder, skill.file);
    if (path === null || !existsSync(path))
      throw modelError(
        "constraint_violation",
        `skill "${skill.id}" of "${manifest.name}" names the file "${skill.file}", which the package does not hold`,
      );
    loaders.set(skill.id, () => readFile(path, "utf8"));
  }
  return loaders;
}

/**
 * The loaders of the topic bodies of a module, by the `file` each topic names:
 * those of the code when it has code, else the files of its folder. A file that
 * does not exist throws `constraint_violation`.
 */
export function docLoaders(
  manifest: ModuleManifest,
  folder: string | null,
  fromCode: ReadonlyMap<string, string>,
): Map<string, DocLoader> {
  const loaders = new Map<string, DocLoader>();
  for (const topic of manifest.docs ?? []) {
    const body = fromCode.get(topic.file);
    if (body !== undefined) {
      loaders.set(topic.file, async () => body);
      continue;
    }
    const path = folder === null ? null : join(folder, topic.file);
    if (path === null || !existsSync(path))
      throw modelError(
        "constraint_violation",
        `topic "${topic.id}" of "${manifest.name}" names the file "${topic.file}", which the package does not hold`,
      );
    loaders.set(topic.file, () => readFile(path, "utf8"));
  }
  return loaders;
}

/**
 * Loads the module of a folder: reads `module.yaml` and validates it as an
 * instance of `module` (`readModuleManifest` of `@scfloworg/core`); when
 * `dist/module.js` exists, checks it with `checkBundle` before it imports it;
 * then checks the code against the manifest (`checkModuleCode`). The body of a
 * skill comes from the bundle, or, for a module with no code, from its file,
 * which must exist and is read when it is asked for. A bundle that
 * breaks the bundle check throws `constraint_violation` and never runs. An
 * error of the file system, such as a missing `module.yaml`, is thrown as is.
 */
async function load(path: string): Promise<ModulePackage> {
  const folder = resolve(path);
  const manifest = readModuleManifest(await readFile(join(folder, MANIFEST_FILE), "utf8"));
  const bundlePath = join(folder, BUNDLE_FILE);
  let exported: { default: unknown } | null = null;
  let bundle: string | null = null;
  if (existsSync(bundlePath)) {
    bundle = bundlePath;
    exported = await importBundle(manifest.name, bundlePath, await readFile(bundlePath, "utf8"));
  }
  const { actions, migrations, skills, docs } = checkModuleCode(manifest, exported);
  return {
    path: folder,
    manifest,
    bundle,
    actions,
    migrations,
    skills: skillLoaders(manifest, folder, skills),
    docs: docLoaders(manifest, folder, docs),
  };
}

/**
 * Checks the text of a bundle and imports it, returning its module namespace.
 * The import names the file with its modification of the text, so a bundle
 * built again in the same process is imported again.
 */
export async function importBundle(key: string, file: string, text: string): Promise<{ default: unknown }> {
  const findings = checkBundle(text);
  if (findings.length > 0) {
    throw modelError(
      "constraint_violation",
      `the bundle of "${key}" breaks the bundle check:\n${formatFindings(findings)}`,
    );
  }
  const url = pathToFileURL(file);
  url.search = `v=${hash(text)}`;
  return (await import(/* @vite-ignore */ url.href)) as { default: unknown };
}

/** A short digest of a text, to tell two builds of one bundle apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

/** The modules of a host that reads them from disk. */
export const modules = { load } as const;

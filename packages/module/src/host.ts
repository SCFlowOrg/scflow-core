/**
 * `modules.load(path)`: the module of a folder, for a host that reads modules
 * from disk (see `docs/module-packages.md`, Load a module).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { modelError, readModuleManifest, type ModuleManifest } from "@scfloworg/core";
import { checkBundle, formatFindings } from "./check.js";
import type { ModuleBody, ModuleDefinition } from "./index.js";

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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBodies = (value: unknown): value is Record<string, ModuleBody> =>
  isRecord(value) && Object.values(value).every((body) => typeof body === "function");

/**
 * Checks the code of a module against its manifest and returns its bodies by
 * action id and by version. `bundle` holds the default export of the bundle,
 * or is `null` for a module with no code. It throws `constraint_violation` when the
 * default export is not the result of `defineModule`, when the manifest it
 * inlines is not `manifest` by name and version, when an action of the code is
 * not declared, when a declared action with no `body` has no code, and when a
 * migration of the code reaches a version no migration of the manifest
 * declares.
 */
export function checkModuleCode(
  manifest: ModuleManifest,
  bundle: { readonly default: unknown } | null,
): { actions: Map<string, ModuleBody>; migrations: Map<string, ModuleBody> } {
  const key = manifest.name;
  const actions = new Map<string, ModuleBody>();
  const migrations = new Map<string, ModuleBody>();

  if (bundle !== null) {
    const code = bundle.default;
    if (!isRecord(code) || !isRecord(code.manifest) || !isBodies(code.actions) || !isBodies(code.migrations)) {
      throw modelError(
        "constraint_violation",
        `the bundle of "${key}" must export by default the result of defineModule`,
      );
    }
    const definition = code as unknown as ModuleDefinition;
    const inlined = definition.manifest;
    if (inlined.name !== key || inlined.version !== manifest.version) {
      throw modelError(
        "constraint_violation",
        `the bundle of "${key}" ${manifest.version} holds the module "${String(inlined.name)}" ` +
          `${String(inlined.version)}: build it again`,
      );
    }
    const declared = new Set(manifest.actions.map((action) => action.id as string));
    for (const [name, body] of Object.entries(definition.actions)) {
      const id = `${manifest.namespace}/${name}`;
      if (!declared.has(id))
        throw modelError("constraint_violation", `the bundle of "${key}" has code for "${id}", which it does not declare`);
      actions.set(id, body);
    }
    const versions = new Set<unknown>(
      (manifest.migrations as unknown[]).filter(isRecord).map((migration) => migration.to),
    );
    for (const [version, body] of Object.entries(definition.migrations)) {
      if (!versions.has(version)) {
        throw modelError(
          "constraint_violation",
          `the bundle of "${key}" has a migration to ${version}, which the manifest does not declare`,
        );
      }
      migrations.set(version, body);
    }
  }

  for (const action of manifest.actions) {
    const id = action.id as string;
    const hasBody = action.body !== undefined && action.body !== null && action.body !== "";
    if (!hasBody && !actions.has(id))
      throw modelError("constraint_violation", `action "${id}" of "${key}" has no procedure and no code`);
  }
  return { actions, migrations };
}

/**
 * Loads the module of a folder: reads `module.yaml` and validates it as an
 * instance of `module` (`readModuleManifest` of `@scfloworg/core`); when
 * `dist/module.js` exists, checks it with `checkBundle` before it imports it;
 * then checks the code against the manifest (`checkModuleCode`). A bundle that
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
  const { actions, migrations } = checkModuleCode(manifest, exported);
  return { path: folder, manifest, bundle, actions, migrations };
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

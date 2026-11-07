/**
 * `checkModuleCode`: the code of a module checked against its manifest, for
 * every host: `modules.load` and an environment that installs a module given
 * by `defineModule` (see `docs/module-packages.md`, Load a module). It reads no
 * file, so a browser bundle can import it.
 */
import { modelError, type ModuleManifest } from "@scfloworg/core";
import type { ModuleBody, ModuleDefinition } from "./index.js";

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
    if (
      !isRecord(code) ||
      !isRecord(code.manifest) ||
      !isBodies(code.actions) ||
      !isBodies(code.migrations)
    ) {
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
        throw modelError(
          "constraint_violation",
          `the bundle of "${key}" has code for "${id}", which it does not declare`,
        );
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
      throw modelError(
        "constraint_violation",
        `action "${id}" of "${key}" has no procedure and no code`,
      );
  }
  return { actions, migrations };
}

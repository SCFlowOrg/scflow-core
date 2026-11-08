import { modelError } from "./errors.js";
import type { ModuleManifest } from "./mclCore.js";
import type { Delta } from "./api.js";
import type { PersistenceInterface, TransientObject, TransientValue } from "./types.js";
import type { DatasetModel } from "./datasetModules.js";
import { keyPropertyName } from "./schema.js";
import { NO_ROLES, derivePropertyRoles } from "./schemaProcessing.js";

/**
 * The migrations of a module upgrade (see `docs/model-upgrade.md`, Upgrading a
 * module, and Model Upgrade in `docs/spec/meta-model.md`): which migrations
 * apply, in which order, and the declared forms the engine applies itself.
 */

/** One migration of a module upgrade, as `upgradeModule` hands it to its `migrate` hook. */
export interface MigrationStep {
  /** The key of the module. */
  readonly module: string;
  /** The version embedded in the dataset before the upgrade. */
  readonly from: string;
  /** The version this migration reaches: its `to`. */
  readonly to: string;
  /** The entry of the manifest, as authored. */
  readonly migration: TransientValue;
}

/** What `ApiSession.upgradeModule` takes besides the manifest. */
export interface UpgradeModuleOptions {
  /**
   * Runs a migration the host has code for, through the session of the
   * upgrade so that its commands join the transaction, and resolves to `true`;
   * resolves to `false` to let the engine apply the declared form of the
   * migration. Without it, the engine applies every declared form.
   */
  migrate?: (step: MigrationStep) => Promise<boolean>;
}

/** What `ApiSession.upgradeModule` returns. */
export interface UpgradeModuleResult {
  /** The key of the module. */
  readonly module: string;
  /** The version embedded before the upgrade. */
  readonly from: string;
  /** The version embedded now: the version of the manifest given. */
  readonly to: string;
  /** The `to` of each migration that ran, in order. */
  readonly migrations: readonly string[];
  /** Whether an instance changed. */
  readonly changed: boolean;
  /** The delta of the transaction, or `null` on a format without transactions or in a joined transaction. */
  readonly delta: Delta | null;
}

/** Compares two semantic versions `major.minor.patch`: negative when `a` is older, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => version.split(/[.+-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The migrations of `manifest` that carry a dataset from the version `from`:
 * those whose `to` is newer than `from` and not newer than the version of the
 * manifest, in version order. An entry without a `to` is ignored.
 */
export function migrationsBetween(manifest: ModuleManifest, from: string): MigrationStep[] {
  return manifest.migrations
    .filter(
      (m): m is TransientObject =>
        m !== null &&
        typeof m === "object" &&
        !Array.isArray(m) &&
        typeof (m as TransientObject).to === "string",
    )
    .filter(
      (m) =>
        compareVersions(m.to as string, from) > 0 &&
        compareVersions(m.to as string, manifest.version) <= 0,
    )
    .sort((a, b) => compareVersions(a.to as string, b.to as string))
    .map((migration) => ({ module: manifest.name, from, to: migration.to as string, migration }));
}

/** The forms a migration can take: exactly one per migration. */
const MIGRATION_FORMS = ["rename_property", "rename_schema", "delete_property", "body"] as const;

/** The models of a module upgrade: before and after the installed manifest replaces the embedded one. */
export interface UpgradeModels {
  readonly before: DatasetModel;
  readonly after: DatasetModel;
}

/**
 * Applies the declared form of a migration (`rename_property`,
 * `rename_schema`, `delete_property`) to the stored values of the dataset,
 * through `target`, the delta-capturing writer of the transaction of the
 * upgrade, so a rollback undoes it. A declared form rewrites the stored values
 * directly, by name, whatever schema declares them: the names of its operand
 * are short names of the module `namespace`, or qualified names. The roles
 * and key of a schema come from the installed model, or from the embedded one
 * for a schema the installed module no longer declares (the `from` of a
 * `rename_schema`). Resolves to the qualified names of a `rename_schema`, so
 * that the check at the end lets a relation follow its schema.
 *
 * Throws `constraint_violation` for a migration with more than one form or an
 * operand without its names, and `incompatible_upgrade` for a migration with
 * no declared form (a `body`, or none) that no host code ran.
 */
export async function applyDeclaredMigration(
  target: PersistenceInterface,
  rest: string,
  locator: string,
  namespace: string,
  step: MigrationStep,
  models: UpgradeModels,
): Promise<{ from: string; to: string } | undefined> {
  const where = `upgrading "${step.module}" of "${locator}"`;
  const raw = step.migration as TransientObject;
  const forms = MIGRATION_FORMS.filter((f) => raw[f] !== undefined && raw[f] !== null);
  if (forms.length > 1) {
    throw modelError("constraint_violation", `${where}: the migration to ${step.to} has ${forms.length} forms, and a migration has exactly one`);
  }
  const form = forms[0];
  if (form === undefined || form === "body") {
    throw modelError("incompatible_upgrade", `${where}: the migration to ${step.to} has no declared form, and no code runs it`);
  }
  const keys = form === "rename_schema" ? ["from", "to"] : form === "rename_property" ? ["schema", "from", "to"] : ["schema", "property"];
  const operand = raw[form];
  if (operand === null || typeof operand !== "object" || Array.isArray(operand) || keys.some((k) => typeof (operand as TransientObject)[k] !== "string")) {
    throw modelError("constraint_violation", `${where}: ${form} of the migration to ${step.to} takes ${keys.join(", ")}`);
  }
  const names = operand as Record<string, string>;
  const qualify = (name: string) => (name.includes(".") ? name : `${namespace}.${name}`);
  const schemaOf = (name: string) => models.after.schemas.get(name) ?? models.before.schemas.get(name);
  const rolesOf = (name: string) => {
    const schema = schemaOf(name);
    return schema ? derivePropertyRoles(schema) : NO_ROLES;
  };
  const keyOf = (name: string, instance: TransientObject) => {
    const schema = schemaOf(name);
    const keyProp = schema ? keyPropertyName(schema) : undefined;
    return (keyProp ? instance[keyProp] : (instance.name ?? instance.id)) as string;
  };

  if (form === "rename_schema") {
    const from = qualify(names.from);
    const to = qualify(names.to);
    const roles = rolesOf(from);
    for (const stored of await target.listInstances(rest, from, roles)) {
      const instance = stored as TransientObject;
      const key = keyOf(from, instance);
      await target.putInstance(rest, to, key, instance, rolesOf(to));
      await target.deleteInstance(rest, from, key);
    }
    return { from, to };
  }
  const schema = qualify(names.schema);
  const property = form === "rename_property" ? names.from : names.property;
  for (const stored of await target.listInstances(rest, schema, rolesOf(schema))) {
    if (!Object.prototype.hasOwnProperty.call(stored, property)) continue;
    const instance = { ...(stored as TransientObject) };
    if (form === "rename_property") instance[names.to] = instance[property];
    delete instance[property];
    await target.putInstance(rest, schema, keyOf(schema, instance), instance, rolesOf(schema));
  }
  return undefined;
}

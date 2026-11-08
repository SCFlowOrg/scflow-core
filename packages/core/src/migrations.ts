import { modelError } from "./errors.js";
import type { ModuleManifest } from "./mclCore.js";
import type { Delta } from "./api.js";
import type { MclAccess, TransientObject, TransientValue } from "./types.js";

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

/**
 * Applies the declared form of a migration (`rename_property`,
 * `rename_schema`, `delete_property`) to the dataset at `locator`, inside the
 * transaction of the upgrade. The declared forms are not implemented yet: a
 * migration that no host code runs refuses the upgrade with
 * `incompatible_upgrade`.
 */
export async function applyDeclaredMigration(
  _access: MclAccess,
  locator: string,
  step: MigrationStep,
): Promise<void> {
  throw modelError(
    "incompatible_upgrade",
    `upgrading "${step.module}" of "${locator}": the migration to ${step.to} has no code, and the declared forms of a migration are not implemented yet`,
  );
}

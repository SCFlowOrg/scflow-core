import * as YAML from "js-yaml";
import { assertDistinct, computePropertyValue, requiresDistinct, resolveCommandForm, runCommand as runCommandEngine, validateMapValue, validateScalarValue } from "./command.js";
import { META_SCHEMAS } from "./builtins.js";
import { modelError } from "./errors.js";
import { isOwnProperty } from "./extensions.js";
import { ensureExtensionInstances } from "./extensionUpgrade.js";
import {
  computeModelDiff,
  clone as cloneUpgrade,
  getUpgradeMarker,
  isModelSchema,
  setUpgradeMarker,
  setUpgradeSnapshot,
} from "./modelUpgrade.js";
import { loadResolvers } from "./resolvers.js";
import { isEmbedded, keyPropertyName } from "./schema.js";
import { createScriptSession as createScriptSessionEngine, runScript as runScriptEngine } from "./script.js";
import { NO_ROLES, SCHEMA_ROLES, derivePropertyRoles, resolveType } from "./schemaProcessing.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import type { Resolvers } from "./resolvers.js";
import type {
  AuthoredCommand,
  AuthoredScript,
  Command,
  CommandResult,
  Key,
  NormalizedProperty,
  NormalizedScalarType,
  NormalizedSchema,
  ObservableChange,
  ObservableDelta,
  ObservableListener,
  PersistenceInterface,
  Script,
  ScriptCommand,
  TransientObject,
  TransientValue,
} from "./types.js";
export type { ObservableChange, ObservableDelta, ObservableListener };
import type { ScriptSession } from "./script.js";

/**
 * The modelling language's public surface; usage is in `docs/mcl.md`.
 * Every function takes `locator: string` as a plain argument — no session/handle object,
 * so the same Command/Script is replayable against any locator.
 */

const registry = new Map<string, PersistenceInterface>();

/** Registers `impl` under `impl.name`, the prefix of the locators it serves; a later registration under the same name replaces the earlier one. */
export function registerPersistentFormat(impl: PersistenceInterface): void {
  registry.set(impl.name, impl);
}

function splitLocator(locator: string): { formatName: string; rest: string } {
  const i = locator.indexOf(":");
  if (i === -1) {
    return { formatName: locator, rest: "" };
  }
  return { formatName: locator.slice(0, i), rest: locator.slice(i + 1) };
}

function resolveImpl(locator: string): { impl: PersistenceInterface; rest: string } {
  const { formatName, rest } = splitLocator(locator);
  const impl = registry.get(formatName);
  if (!impl) throw modelError("unknown_persistent_format", `no persistent format registered for "${formatName}"`);
  return { impl, rest };
}

async function bumpVersion(impl: PersistenceInterface, rest: string, field: "model_minor_version" | "data_minor_version") {
  const dataset = (await impl.getDataset(rest)) as TransientObject;
  const current = typeof dataset[field] === "number" ? (dataset[field] as number) : 0;
  await impl.updateDataset(rest, { [field]: current + 1, updated_at: new Date().toISOString() });
}

/**
 * Runs `fn` under `rest`'s write lock when the format provides one, and
 * releases it however `fn` settles. The lock is not re-entrant, so `fn` never
 * calls back into another `withLock` on the same `rest`.
 */
async function withLock<T>(impl: PersistenceInterface, rest: string, fn: () => Promise<T>): Promise<T> {
  if (!impl.lock) return fn();
  const release = await impl.lock(rest);
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Built-in overlay (document_part-definition-import.md's "Built-in — virtual,
// not imported", `PersistenceInterface`'s `builtinRestFor`): a dataset never copies its area's built-in
// schemas/scalar_types in, and never gets a standing import for them.
// `initDataset` does nothing built-in-related at all; `loadResolvers`
// (resolvers.ts) and `datasetTransientForm` below read the built-in live,
// every time, via `builtinRestFor`. `dumpDataset` and `restoreDataset` are the
// only two places that touch the `import` schema for the built-in, and only
// as bookkeeping — see below.
// ---------------------------------------------------------------------------

/**
 * The area's built-in dataset for `rest` — its current schema/scalar_type
 * instances, resolved live via `builtinRestFor` — or `null` if no dataset
 * exists yet at the rest `builtinRestFor` names. Never copied or cached:
 * every caller sees whatever the built-in currently holds. `resolvers.ts`'s
 * `loadResolvers` has its own small copy of this same lookup (command
 * processing can't import from here without a cycle) — keep the two in sync.
 */
async function loadBuiltinOverlay(
  impl: PersistenceInterface,
  rest: string,
): Promise<{ builtinRest: string; schemas: NormalizedSchema[]; scalarTypes: NormalizedScalarType[] } | null> {
  const builtinRest = impl.builtinRestFor(rest);
  if (!(await impl.datasetExists(builtinRest))) return null;
  const [schemaInstances, scalarTypeInstances] = await Promise.all([
    impl.listInstances(builtinRest, "schema", SCHEMA_ROLES),
    impl.listInstances(builtinRest, "scalar_type", NO_ROLES),
  ]);
  return {
    builtinRest,
    schemas: schemaInstances.map((raw) => raw as unknown as NormalizedSchema),
    scalarTypes: scalarTypeInstances.map((raw) => raw as unknown as NormalizedScalarType),
  };
}

/**
 * The shape `dumpDataset` synthesizes for the area's built-in, and
 * `restoreDataset` recognizes by its empty `namespace` — never an instance
 * actually stored via `putInstance` against `rest`'s own `import` schema; see
 * document_part-definition-import.md's `import` schema block for the full
 * shape shared with every other kind of import.
 */
interface BuiltinImportRecord extends TransientObject {
  name: string;
  locator: string;
  namespace: string;
  model_major_version: number;
  model_minor_version: number;
  data_major_version: number;
  data_minor_version: number;
  caching_policy: "full" | "partial" | "none";
  imported_schemas: string[];
  imported_scalar_types: string[];
}

const BUILTIN_IMPORT_NAME = "builtin";

/**
 * Builds the bookkeeping-only `import` entry `dumpDataset` includes for the
 * area's built-in — no schema/scalar_type content: its `locator`, the names
 * it currently overlays (`imported_schemas`/`imported_scalar_types`), and its
 * four versions at `0`. A built-in can be assembled at run time by its host,
 * so its own version numbers say nothing about its content; `restoreDataset`
 * ignores them and checks the restored instances instead.
 */
function builtinImportRecord(
  impl: PersistenceInterface,
  builtinRest: string,
  overlay: { schemas: NormalizedSchema[]; scalarTypes: NormalizedScalarType[] },
): BuiltinImportRecord {
  return {
    name: BUILTIN_IMPORT_NAME,
    locator: `${impl.name}:${builtinRest}`,
    namespace: "",
    model_major_version: 0,
    model_minor_version: 0,
    data_major_version: 0,
    data_minor_version: 0,
    caching_policy: "none",
    imported_schemas: overlay.schemas.map((s) => s.name),
    imported_scalar_types: overlay.scalarTypes.map((s) => s.name),
  };
}

// ---------------------------------------------------------------------------
// Dormant instances (document_part-definition-import.md's "Dormant
// instances"): an instance whose schema is neither in its dataset, nor in the
// meta-model, nor in its area's current built-in. `restoreDataset` stores it
// as it is and records its schema and key in an internal instance of `rest`,
// the way modelUpgrade.ts records an upgrade locator's marker: no command
// addresses that schema, so the record and the dormant instances stay out of
// every query and command. `dumpDataset` reads the record to write the
// dormant instances back unchanged.
// ---------------------------------------------------------------------------

const DORMANT_RECORD_SCHEMA = "__dormant_instances__";
const DORMANT_RECORD_KEY = "self";

/** Schema name → keys of the dormant instances `rest` holds. */
type DormantRecord = Record<string, string[]>;

async function getDormantRecord(impl: PersistenceInterface, rest: string): Promise<DormantRecord> {
  const raw = (await impl.getInstance(rest, DORMANT_RECORD_SCHEMA, DORMANT_RECORD_KEY, NO_ROLES)) as TransientObject | null;
  return raw !== null && isPlainObject(raw.schemas) ? (raw.schemas as unknown as DormantRecord) : {};
}

async function setDormantRecord(impl: PersistenceInterface, rest: string, record: DormantRecord): Promise<void> {
  await impl.putInstance(rest, DORMANT_RECORD_SCHEMA, DORMANT_RECORD_KEY, { schemas: record } as unknown as TransientValue, NO_ROLES);
}

/**
 * Checks every restored instance of a built-in schema against that schema's
 * *current* definition, per document_part-definition-import.md's "Built-in —
 * virtual, not imported" — whatever versions the dump recorded. A valid
 * instance is left as it is, one that becomes valid by backfilling defaults
 * is upgraded in place (`reconcileInstanceAgainstSchema` below), and the
 * first one that cannot be throws `incompatible_upgrade`; `restoreDataset`
 * then deletes the dataset it was creating. A built-in schema shadowed by one
 * of `rest`'s own (`ownSchemaNames`) is skipped: `rest`'s own wins.
 *
 * This is a single-schema check rather than the old-vs-new
 * `classifySchemaInstances`/`backfillInstance` machinery `upgradeDataset`
 * uses below: that machinery needs both versions of the schema, and the dump
 * carries none of the built-in's content.
 */
async function reconcileRestoredBuiltinData(
  impl: PersistenceInterface,
  rest: string,
  locator: string,
  ownSchemaNames: Set<string>,
): Promise<void> {
  const overlay = await loadBuiltinOverlay(impl, rest);
  if (!overlay) return;

  const resolvers = await loadResolvers(impl, rest);
  const datasetValue = await impl.getDataset(rest);

  for (const schema of overlay.schemas) {
    if (ownSchemaNames.has(schema.name)) continue;
    const keyProp = keyPropertyName(schema);
    if (!keyProp) continue; // embedded — never independently stored
    const roles = derivePropertyRoles(schema);
    for (const raw of await impl.listInstances(rest, schema.name, roles)) {
      const reconciled = reconcileInstanceAgainstSchema(schema, raw as TransientObject, resolvers.ctx, datasetValue, locator);
      if (reconciled) await impl.putInstance(rest, schema.name, reconciled[keyProp] as string, reconciled, roles);
    }
  }
}

/**
 * Checks one already-stored instance against `schema` as it stands *right
 * now* — backfilling a property missing from the instance exactly as
 * `backfillInstance` below does for a freshly-added property (scalars always
 * resolve some default; a missing mandatory relation is incompatible),
 * dropping an instance property no longer declared on `schema` (other than
 * its own key), and re-validating every scalar property already present
 * against `schema`'s current constraints. Generated (virtual) properties are
 * never stored, so they are neither backfilled nor checked. Returns the
 * reconciled instance, or `null` if nothing needed to change.
 */
function reconcileInstanceAgainstSchema(
  schema: NormalizedSchema,
  instance: TransientObject,
  ctx: TypeResolutionContext,
  datasetValue: TransientValue,
  locator: string,
): TransientObject | null {
  const keyProp = keyPropertyName(schema);
  const props = new Map(schema.properties.map((p) => [p.name, p] as const));
  let touched = false;
  const result: TransientObject = { ...instance };

  for (const key of Object.keys(instance)) {
    if (key === keyProp || props.has(key)) continue;
    delete result[key];
    touched = true;
  }

  for (const [name, prop] of props) {
    if (prop.constraints.__generated === true || !isOwnProperty(prop)) continue;
    const hasProvided = Object.prototype.hasOwnProperty.call(instance, name) && instance[name] !== undefined;
    let resolved: ReturnType<typeof resolveType>;
    try {
      resolved = resolveType(prop.type, ctx);
    } catch {
      throw modelError(
        "incompatible_upgrade",
        `restoring "${locator}": built-in schema "${schema.name}"'s property "${name}" has an unresolvable type "${prop.type}"`,
      );
    }

    if (!hasProvided) {
      if (resolved.kind === "relation" && prop.constraints.mandatory === true) {
        throw modelError(
          "incompatible_upgrade",
          `restoring "${locator}": an existing "${schema.name}" instance has no value for "${name}", now mandatory on the built-in's current schema`,
        );
      }
      result[name] = computePropertyValue(prop, false, undefined, resolved, result, schema, datasetValue);
      touched = true;
      continue;
    }

    if (resolved.kind === "scalar") {
      const eff = { ...resolved.constraints, ...prop.constraints };
      const value = result[name];
      const isArray = prop.constraints.is_array === true;
      try {
        if (isArray) {
          if (requiresDistinct(prop.constraints)) assertDistinct(name, Array.isArray(value) ? value : []);
          for (const v of Array.isArray(value) ? value : []) validateScalarValue(name, resolved.base, v, eff);
        } else {
          validateScalarValue(name, resolved.base, value, eff);
        }
      } catch {
        throw modelError(
          "incompatible_upgrade",
          `restoring "${locator}": an existing "${schema.name}" instance's "${name}" no longer satisfies the built-in's current schema`,
        );
      }
    }
  }

  return touched ? result : null;
}

// ---------------------------------------------------------------------------
// Dataset lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates an empty dataset named `name` at `locator` and returns its transient form; observers get a reset.
 * Throws `unknown_persistent_format` and `dataset_already_exists`. See `docs/datasets.md`.
 */
export async function initDataset(locator: string, name: string): Promise<TransientValue> {
  const { impl, rest } = resolveImpl(locator);
  await impl.createDataset(rest, name);
  notifyObservable(locator, { kind: "reset" });
  return datasetTransientForm(impl, rest);
}

/**
 * Assembles a dataset's transient form per the `dataset` schema of the
 * `dataset_unit` part (dataset `core`): the scalar fields from getDataset (name,
 * the four version numbers, created_at/updated_at) plus
 * schemas/scalar_types/imports as arrays of names — a relation value is always
 * a Key (name), never a nested object (see `TransientValue`).
 * `schemas`/`scalar_types` include the area's built-in overlay (see
 * `loadBuiltinOverlay`) alongside `rest`'s own; `rest`'s own names win on a
 * name collision. `imports` is always `[]`: the built-in is never a standing
 * import (`import` part, "Built-in — virtual, not imported").
 */
async function datasetTransientForm(impl: PersistenceInterface, rest: string): Promise<TransientValue> {
  const info = (await impl.getDataset(rest)) as TransientObject;
  const [schemas, scalarTypes] = await Promise.all([
    impl.listInstances(rest, "schema", SCHEMA_ROLES),
    impl.listInstances(rest, "scalar_type", NO_ROLES),
  ]);
  const names = (instances: TransientValue[]) => instances.map((i) => (i as TransientObject).name);
  const ownSchemaNames = new Set(names(schemas));
  const ownScalarTypeNames = new Set(names(scalarTypes));
  const overlay = await loadBuiltinOverlay(impl, rest);
  const overlaySchemaNames = overlay ? overlay.schemas.map((s) => s.name).filter((n) => !ownSchemaNames.has(n)) : [];
  const overlayScalarTypeNames = overlay ? overlay.scalarTypes.map((s) => s.name).filter((n) => !ownScalarTypeNames.has(n)) : [];
  return {
    ...info,
    schemas: [...names(schemas), ...overlaySchemaNames],
    scalar_types: [...names(scalarTypes), ...overlayScalarTypeNames],
    imports: [],
  };
}

/** Returns the transient form of the dataset at `locator`, or `null` when none exists. Throws `unknown_persistent_format`. */
export async function queryDataset(locator: string): Promise<TransientValue> {
  const { impl, rest } = resolveImpl(locator);
  if (!(await impl.datasetExists(rest))) return null;
  return datasetTransientForm(impl, rest);
}

/**
 * Bumps model_major_version and/or data_major_version by 1, resetting that
 * part's minor version to 0 (semver-style).
 */
export async function bumpMajorVersions(locator: string, bumpModel: boolean, bumpPdata: boolean): Promise<TransientValue> {
  const { impl, rest } = resolveImpl(locator);
  const dataset = (await impl.getDataset(rest)) as TransientObject;
  const patch: TransientObject = { updated_at: new Date().toISOString() };
  if (bumpModel) {
    const current = typeof dataset.model_major_version === "number" ? dataset.model_major_version : 0;
    patch.model_major_version = current + 1;
    patch.model_minor_version = 0;
  }
  if (bumpPdata) {
    const current = typeof dataset.data_major_version === "number" ? dataset.data_major_version : 0;
    patch.data_major_version = current + 1;
    patch.data_minor_version = 0;
  }
  await impl.updateDataset(rest, patch);
  return datasetTransientForm(impl, rest);
}

/**
 * Removes the dataset at `locator` and returns its transient form as it was before removal; observers get a reset.
 * Throws `unknown_persistent_format` and `dataset_not_found`.
 */
export async function deleteDataset(locator: string): Promise<TransientValue> {
  const { impl, rest } = resolveImpl(locator);
  const before = await datasetTransientForm(impl, rest); // throws dataset_not_found if missing
  await impl.deleteDataset(rest);
  notifyObservable(locator, { kind: "reset" });
  return before;
}

/** What `restoreDataset` returns: the restored dataset, and the imports restored without data (caching policy `none`) that still need realigning. */
export interface RestoreResult {
  dataset: TransientValue;
  pendingRealignment: TransientValue[];
}

type DumpFormat = "json" | "yaml";

function serialize(value: TransientValue, format: DumpFormat): string {
  return format === "yaml" ? YAML.dump(value, { noRefs: true, lineWidth: -1 }) : JSON.stringify(value, null, 2);
}

function deserialize(dump: string, format: DumpFormat): unknown {
  try {
    return format === "yaml" ? YAML.load(dump) : JSON.parse(dump);
  } catch (err) {
    throw modelError("invalid_dump", `dump does not parse as ${format}: ${(err as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is TransientObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation only — confirms the parsed dump has the shape
 * dumpDataset itself produces (a `dataset` record plus `schemas`/`scalar_types`/
 * `imports`/`data` dictionaries), not full meta-model validation (re-running
 * Schema Processing over every dumped schema/scalar_type, Command's instance
 * validation over every dumped instance). That deeper pass is out of scope for
 * this first implementation — flagged in scaffoldplan-log.md.
 */
function validateDumpShape(
  parsed: unknown,
): asserts parsed is {
  dataset: TransientObject;
  schemas: TransientObject;
  scalar_types: TransientObject;
  imports: TransientObject;
  data: TransientObject;
} {
  if (!isPlainObject(parsed)) throw modelError("invalid_dump", "dump is not an object");
  const { dataset, schemas, scalar_types, imports, data } = parsed;
  if (!isPlainObject(dataset) || typeof dataset.name !== "string") {
    throw modelError("invalid_dump", "dump has no dataset.name");
  }
  if (!isPlainObject(schemas)) throw modelError("invalid_dump", "dump.schemas is not an object");
  if (!isPlainObject(scalar_types)) throw modelError("invalid_dump", "dump.scalar_types is not an object");
  if (!isPlainObject(imports)) throw modelError("invalid_dump", "dump.imports is not an object");
  if (!isPlainObject(data)) throw modelError("invalid_dump", "dump.data is not an object");
}

/**
 * Serializes the dataset's model (schemas, scalar types) and data (every
 * instance of every schema the dataset itself defines) as a single string.
 * Deliberately dumps by schema name rather than filtering on `is_root`: the
 * fixture model in packages/conformance only tags `task` `is_root: true`
 * (not `person`/`comment`, which are still queried/created directly at the
 * top level today) — `is_root` isn't consistently authored yet, and every
 * schema already has its own independent store regardless of it. Embedded
 * schemas are skipped: they have no store of their own, only ever nesting
 * inside their owner's instance. See scaffoldplan-log.md for the full
 * reasoning; worth revisiting once the dataset's own auto-relation-per-root-
 * schema mechanism (document_part-feature-dataset.md) is implemented.
 */
export async function dumpDataset(locator: string, format: DumpFormat): Promise<string> {
  const { impl, rest } = resolveImpl(locator);
  const info = (await impl.getDataset(rest)) as TransientObject; // throws dataset_not_found if missing

  const [schemaInstances, scalarTypeInstances, importInstances] = await Promise.all([
    impl.listInstances(rest, "schema", SCHEMA_ROLES),
    impl.listInstances(rest, "scalar_type", NO_ROLES),
    impl.listInstances(rest, "import", NO_ROLES),
  ]);

  const schemas: TransientObject = {};
  for (const raw of schemaInstances) schemas[(raw as unknown as NormalizedSchema).name] = raw;

  const scalarTypes: TransientObject = {};
  for (const raw of scalarTypeInstances) scalarTypes[(raw as TransientObject).name as string] = raw;

  const imports: TransientObject = {};
  for (const raw of importInstances) imports[(raw as TransientObject).name as string] = raw;

  // The area's built-in is never physically stored in `rest` — its
  // bookkeeping-only `import` entry is synthesized here instead of read back
  // from storage, and no schema/scalar_type content is added to
  // `schemas`/`scalar_types` for it.
  const overlay = await loadBuiltinOverlay(impl, rest);
  if (overlay) {
    const record = builtinImportRecord(impl, overlay.builtinRest, overlay);
    imports[record.name] = record as unknown as TransientValue;
  }

  // Data collection covers `rest`'s own schemas AND the built-in's — an
  // instance of a built-in schema (e.g. a "widget") is real, physically
  // stored data in `rest` even though the "widget" schema definition itself
  // is never stored there.
  const data: TransientObject = {};
  const schemasForData = [...schemaInstances.map((raw) => raw as unknown as NormalizedSchema), ...(overlay?.schemas ?? [])];
  for (const schema of schemasForData) {
    if (isEmbedded(schema)) continue;
    const key = keyPropertyName(schema);
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(data, schema.name)) continue; // `rest`'s own wins over the built-in's
    const instances = await impl.listInstances(rest, schema.name, derivePropertyRoles(schema));
    const bySchemaKey: TransientObject = {};
    for (const instance of instances) bySchemaKey[(instance as TransientObject)[key] as string] = instance;
    data[schema.name] = bySchemaKey;
  }

  // Dormant instances are written back unchanged. One whose schema has
  // become available since is an ordinary instance, already dumped above.
  for (const [schemaName, keys] of Object.entries(await getDormantRecord(impl, rest))) {
    if (Object.prototype.hasOwnProperty.call(data, schemaName)) continue;
    const bySchemaKey: TransientObject = {};
    for (const key of keys) {
      const instance = await impl.getInstance(rest, schemaName, key, NO_ROLES);
      if (instance !== null) bySchemaKey[key] = instance;
    }
    if (Object.keys(bySchemaKey).length > 0) data[schemaName] = bySchemaKey;
  }

  return serialize({ dataset: info, schemas, scalar_types: scalarTypes, imports, data }, format);
}

/**
 * Creates a new dataset at `locator` from a `dumpDataset` output — the exact
 * dumped versions/timestamps are carried over (via `updateDataset` right after
 * `createDataset`), not reset the way a fresh `initDataset` would, since a
 * restore is meant to reproduce the prior state exactly. The area's own
 * built-in, if the dump carries a synthesized entry for it (see
 * `builtinImportRecord`), is never installed as a standing import: every
 * restored instance of a built-in schema is checked against its current
 * definition instead (see `reconcileRestoredBuiltinData`). An instance whose
 * schema is missing everywhere is kept dormant. An instance of a schema that is
 * an extension target, in the dataset or in its built-in, and that has no
 * extension instance in the dump (a dump written before the schema became an
 * extension) gets it, from the defaults, as `upgradeDataset` does; the dump's
 * versions are kept. A restore that fails once the dataset is created deletes
 * it again, so it creates nothing.
 * `pendingRealignment` lists every import restored with a `none` caching
 * policy still needing manual realignment; the built-in never appears in it,
 * and no other kind of import is implemented yet (see scaffoldplan.md), so
 * it is always `[]`.
 */
export async function restoreDataset(locator: string, dump: string, format: DumpFormat): Promise<RestoreResult> {
  const { impl, rest } = resolveImpl(locator);
  const parsed = deserialize(dump, format);
  validateDumpShape(parsed);

  await impl.createDataset(rest, parsed.dataset.name as string); // throws dataset_already_exists
  try {
    await populateRestoredDataset(impl, rest, locator, parsed);
  } catch (err) {
    await impl.deleteDataset(rest);
    throw err;
  }

  notifyObservable(locator, { kind: "reset" });

  return { dataset: await datasetTransientForm(impl, rest), pendingRealignment: [] };
}

async function populateRestoredDataset(
  impl: PersistenceInterface,
  rest: string,
  locator: string,
  parsed: { dataset: TransientObject; schemas: TransientObject; scalar_types: TransientObject; imports: TransientObject; data: TransientObject },
): Promise<void> {
  await impl.updateDataset(rest, parsed.dataset);

  for (const [name, instance] of Object.entries(parsed.scalar_types)) {
    await impl.putInstance(rest, "scalar_type", name, instance, NO_ROLES);
  }
  for (const [name, instance] of Object.entries(parsed.schemas)) {
    await impl.putInstance(rest, "schema", name, instance, SCHEMA_ROLES);
  }
  // The built-in's synthesized entry (namespace "") is never installed as a
  // standing import; every other import is restored as one.
  for (const [name, instance] of Object.entries(parsed.imports)) {
    if ((instance as TransientObject).namespace === "") continue;
    await impl.putInstance(rest, "import", name, instance, NO_ROLES);
  }

  // Roles come from the dump's own schema definition when it's one of
  // `rest`'s own, from the built-in's current one when it's a built-in
  // schema, or from the meta-model. A schema found nowhere makes its
  // instances dormant: stored as they are, with no roles.
  const overlay = await loadBuiltinOverlay(impl, rest);
  const overlaySchemasByName = new Map((overlay?.schemas ?? []).map((s) => [s.name, s] as const));
  const dormant: DormantRecord = {};
  for (const [schemaName, bySchemaKey] of Object.entries(parsed.data)) {
    if (!isPlainObject(bySchemaKey)) throw modelError("invalid_dump", `dump.data.${schemaName} is not an object`);
    const schemaDef =
      (parsed.schemas[schemaName] as unknown as NormalizedSchema | undefined) ??
      overlaySchemasByName.get(schemaName) ??
      (Object.prototype.hasOwnProperty.call(META_SCHEMAS, schemaName) ? META_SCHEMAS[schemaName] : undefined);
    const roles = schemaDef ? derivePropertyRoles(schemaDef) : NO_ROLES;
    for (const [key, instance] of Object.entries(bySchemaKey)) {
      await impl.putInstance(rest, schemaName, key, instance, roles);
    }
    if (!schemaDef) dormant[schemaName] = Object.keys(bySchemaKey);
  }
  if (Object.keys(dormant).length > 0) await setDormantRecord(impl, rest, dormant);

  await reconcileRestoredBuiltinData(impl, rest, locator, new Set(Object.keys(parsed.schemas)));

  // A dump written before a schema became an extension of the schema of its
  // instances, in `rest` or in its built-in, holds no extension instance for
  // them. The versions of the dump are kept, so nothing is bumped here.
  await ensureExtensionInstances(impl, rest, await loadResolvers(impl, rest), await impl.getDataset(rest));
}

// ---------------------------------------------------------------------------
// Model Upgrade — createUpgradeLocator/queryUpgradeLocator/checkUpgrade/
// upgradeDataset; see `docs/model-upgrade.md`.
// `schema`/`scalar_type` are created or changed only through
// runCommand/runScript against an upgrade locator created here, like any other
// instance; see modelUpgrade.ts's `runSchemaCommand`, wired into command.ts's
// engine.
// ---------------------------------------------------------------------------

let upgradeLocatorCounter = 0;

function newUpgradeRest(rest: string): string {
  upgradeLocatorCounter += 1;
  return `${rest}::upgrade::${Date.now()}::${upgradeLocatorCounter}`;
}

/**
 * Creates a temporary dataset holding a copy of `locator`'s current model
 * (schemas + scalar types, not data) and returns its locator. Every
 * subsequent `schema`/`scalar_type` change is made against *that* locator via
 * `runCommand`/`runScript` — never against `locator` itself, see
 * command.ts's `not_upgrade_locator` gating.
 */
export async function createUpgradeLocator(locator: string): Promise<string> {
  const { impl, rest } = resolveImpl(locator);
  if (!(await impl.datasetExists(rest))) throw modelError("dataset_not_found", `no dataset at "${locator}"`);
  const info = (await impl.getDataset(rest)) as TransientObject;

  const upgradeRest = newUpgradeRest(rest);
  await impl.createDataset(upgradeRest, `${String(info.name)} (upgrade)`);

  const schemaSnapshot: Record<string, NormalizedSchema> = {};
  for (const raw of await impl.listInstances(rest, "schema", SCHEMA_ROLES)) {
    const s = raw as unknown as NormalizedSchema;
    schemaSnapshot[s.name] = s;
    await impl.putInstance(upgradeRest, "schema", s.name, raw, SCHEMA_ROLES);
  }
  const scalarSnapshot: Record<string, NormalizedScalarType> = {};
  for (const raw of await impl.listInstances(rest, "scalar_type", NO_ROLES)) {
    const st = raw as unknown as NormalizedScalarType;
    scalarSnapshot[st.name] = st;
    await impl.putInstance(upgradeRest, "scalar_type", st.name, raw, NO_ROLES);
  }

  await setUpgradeSnapshot(impl, upgradeRest, { schemas: schemaSnapshot, scalar_types: scalarSnapshot });
  // Import isn't implemented yet (see scaffoldplan.md) — every upgrade locator
  // is for the local model today, so `namespace` is always "".
  await setUpgradeMarker(impl, upgradeRest, { source_locator: locator, namespace: "" });

  const { formatName } = splitLocator(locator);
  return `${formatName}:${upgradeRest}`;
}

async function requireUpgradeLocator(upgradeLocator: string): Promise<{ impl: PersistenceInterface; rest: string; marker: { source_locator: string; namespace: string } }> {
  const { impl, rest } = resolveImpl(upgradeLocator);
  if (!(await impl.datasetExists(rest))) throw modelError("dataset_not_found", `no dataset at "${upgradeLocator}"`);
  const marker = await getUpgradeMarker(impl, rest);
  if (!marker) throw modelError("not_upgrade_locator", `"${upgradeLocator}" is not an upgrade locator`);
  return { impl, rest, marker };
}

/**
 * Returns the model changes recorded in `upgradeLocator` so far, structured
 * as a `CommandResult`: `before`/`after` hold every added/modified/removed
 * `schema`/`scalar_type` (an addition has no `before` entry, a removal no
 * `after` entry — the two arrays aren't index-parallel here, unlike an
 * ordinary command's, since a batch of model edits is inherently mixed-kind).
 * `cascade-deleted` holds schemas that weren't themselves edited but
 * transitively `extends` one that was — "considered as deleted", per
 * document_part-definition-model_upgrade.md.
 *
 * `source_locator` and `namespace` are the marker's own, so an upgrade
 * locator identifies the dataset it was created for on its own terms: a
 * caller holding nothing but the locator — one left on disk by an earlier
 * process, say — recovers that dataset from here rather than having to
 * remember it from the `createUpgradeLocator` call.
 */
export async function queryUpgradeLocator(upgradeLocator: string): Promise<{ source_locator: string; namespace: string; commandResult: CommandResult }> {
  const { impl, rest, marker } = await requireUpgradeLocator(upgradeLocator);
  const diff = await computeModelDiff(impl, rest);

  const before: TransientValue[] = [];
  const after: TransientValue[] = [];
  for (const entry of [...diff.changed, ...diff.deleted]) {
    if (entry.before !== null) before.push(cloneUpgrade(entry.before));
    if (entry.after !== null) after.push(cloneUpgrade(entry.after));
  }
  const cascadeDeleted = diff.cascadeDeleted.map((entry) => cloneUpgrade(entry.before as TransientValue));

  return {
    source_locator: marker.source_locator,
    namespace: marker.namespace,
    commandResult: { before, after, "cascade-deleted": cascadeDeleted, "updated-before": [], "updated-after": [] },
  };
}

/** Entities impacted by an upgrade: updated automatically (defaulted or removed properties), schema modified without automatic update, schema lost. */
export interface CheckUpgradeResult {
  autoUpdate: TransientValue[];
  modifiedSchema: TransientValue[];
  lostSchema: TransientValue[];
}

/**
 * Whether retargeting a relation from `oldType` to `newType` widens it — that
 * is, whether `newType` is an ancestor of `oldType` through `extends`. A value
 * stored against `oldType` is an instance of it or of a schema extending it,
 * so it is an instance of each of `oldType`'s own ancestors as well. Both a
 * narrowing and a move to an unrelated schema read as false.
 */
function widensRelation(oldType: string, newType: string, ctx: TypeResolutionContext): boolean {
  const seen = new Set<string>([oldType]);
  let current = ctx.resolveSchema(oldType)?.extends ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === newType) return true;
    seen.add(current);
    current = ctx.resolveSchema(current)?.extends ?? null;
  }
  return false;
}

/**
 * Classifies every existing instance of a modified schema as either
 * automatically upgradeable (a backfill on added/removed properties is
 * enough) or not (`modifiedSchema`), per document_part-definition-model_upgrade.md's
 * "Automatic upgrade": "a change that can never invalidate an already-stored
 * value is compatible; a change that could turn an existing stored value into
 * something violating the new schema is not." What exactly counts is "left to
 * implementation" there — this implementation's rule:
 * - a property added with a scalar type is always compatible (every scalar
 *   type resolves *some* default, authored or the base type's own);
 * - a property added as a mandatory relation is never compatible (there is no
 *   value to invent for an existing instance);
 * - a removed property is always compatible (dropped on backfill);
 * - a relation retargeted to an ancestor of its old target — a widening — is
 *   compatible: every stored value is an instance of the old target, so it is
 *   an instance of every schema that one extends, and the retarget alone can
 *   never invalidate it. The instance still counts as touched, so the backfill
 *   rewrites it and whatever a format derives from the target schema (a link's
 *   path, say) is rewritten with it;
 * - any other change of `type`, and any change of relation shape (array-ness),
 *   is incompatible outright rather than inspected value by value: a narrowing
 *   or a sideways retarget can't be safely value-checked without resolving the
 *   other side's instances too, out of scope for a first pass;
 * - a property whose scalar constraints changed (enum, pattern, min/max, ...)
 *   is compatible for instances whose *current* stored value still validates
 *   against the new definition, incompatible otherwise.
 * An instance untouched by any of the above (no added/removed property, no
 * common property whose constraints actually differ) isn't reported at all —
 * it needs no upgrade.
 */
function classifySchemaInstances(
  oldSchema: NormalizedSchema,
  newSchema: NormalizedSchema,
  instances: TransientValue[],
  ctx: TypeResolutionContext,
): { autoUpdate: TransientValue[]; modifiedSchema: TransientValue[] } {
  // the properties an extension adds are stored in the instance of the extension, not in these instances
  const oldProps = new Map(oldSchema.properties.filter(isOwnProperty).map((p) => [p.name, p] as const));
  const newProps = new Map(newSchema.properties.filter(isOwnProperty).map((p) => [p.name, p] as const));
  const added = [...newProps.keys()].filter((n) => !oldProps.has(n));
  const removed = [...oldProps.keys()].filter((n) => !newProps.has(n));
  const common = [...newProps.keys()].filter((n) => oldProps.has(n) && JSON.stringify(oldProps.get(n)) !== JSON.stringify(newProps.get(n)));

  const autoUpdate: TransientValue[] = [];
  const modifiedSchema: TransientValue[] = [];

  for (const raw of instances) {
    const instance = raw as TransientObject;
    let touched = removed.length > 0;
    let incompatible = false;

    for (const name of added) {
      const prop = newProps.get(name) as NormalizedProperty;
      touched = true;
      try {
        const resolved = resolveType(prop.type, ctx);
        if (resolved.kind === "relation" && prop.constraints.mandatory === true) incompatible = true;
      } catch {
        incompatible = true; // e.g. a type this pass's ctx can't resolve — safe default
      }
    }

    for (const name of common) {
      const oldProp = oldProps.get(name) as NormalizedProperty;
      const newProp = newProps.get(name) as NormalizedProperty;
      let resolvedOld: ReturnType<typeof resolveType>;
      let resolvedNew: ReturnType<typeof resolveType>;
      try {
        resolvedOld = resolveType(oldProp.type, ctx);
        resolvedNew = resolveType(newProp.type, ctx);
      } catch {
        incompatible = true;
        continue;
      }
      const currentValue = instance[name];
      const isArrayOld = oldProp.constraints.is_array === true;
      const isArrayNew = newProp.constraints.is_array === true;

      if (resolvedOld.kind === "relation" || resolvedNew.kind === "relation") {
        const retargeted = oldProp.type !== newProp.type;
        if (
          resolvedOld.kind !== resolvedNew.kind ||
          isArrayOld !== isArrayNew ||
          (retargeted && !widensRelation(oldProp.type, newProp.type, ctx))
        ) {
          incompatible = true;
          continue;
        }
        if (retargeted) touched = true;
        if (newProp.constraints.mandatory === true) {
          const empty = isArrayNew ? !Array.isArray(currentValue) || currentValue.length === 0 : currentValue === null || currentValue === undefined;
          if (empty) incompatible = true;
        }
        continue;
      }

      if (resolvedOld.kind === "map" && resolvedNew.kind === "map" && oldProp.type === newProp.type) {
        // the same map type: the stored maps keep their shape, only the new constraints can reject them
        touched = true;
        try {
          validateMapValue(name, resolvedNew, newProp.constraints, currentValue);
        } catch {
          incompatible = true;
        }
        continue;
      }
      if (oldProp.type !== newProp.type || resolvedNew.kind !== "scalar") {
        incompatible = true;
        continue;
      }
      touched = true;
      const eff = { ...resolvedNew.constraints, ...newProp.constraints };
      try {
        if (isArrayNew) {
          if (requiresDistinct(newProp.constraints)) assertDistinct(name, Array.isArray(currentValue) ? currentValue : []);
          for (const v of Array.isArray(currentValue) ? currentValue : []) validateScalarValue(name, resolvedNew.base, v, eff);
        } else {
          validateScalarValue(name, resolvedNew.base, currentValue, eff);
        }
      } catch {
        incompatible = true;
      }
    }

    if (incompatible) {
      modifiedSchema.push(cloneUpgrade(raw));
    } else if (touched) {
      autoUpdate.push(cloneUpgrade(raw));
    }
  }

  return { autoUpdate, modifiedSchema };
}

/**
 * Analyses the data in the dataset at `locator` against the modified model
 * held in `upgradeLocator`. See `classifySchemaInstances` above for what
 * counts as automatic.
 */
export async function checkUpgrade(locator: string, upgradeLocator: string): Promise<CheckUpgradeResult> {
  const { impl, rest } = resolveImpl(locator);
  if (!(await impl.datasetExists(rest))) throw modelError("dataset_not_found", `no dataset at "${locator}"`);
  const { impl: upgradeImpl, rest: upgradeRest } = await requireUpgradeLocator(upgradeLocator);

  const diff = await computeModelDiff(upgradeImpl, upgradeRest);
  // Resolve property types against the upgrade dataset's model, not the real
  // dataset's current (pre-upgrade) one — a property added in this same
  // upgrade batch may reference a scalar_type also newly added in it, which
  // the real dataset doesn't know about yet. Matches upgradeDataset's own
  // backfill below, which resolves against the same upgrade resolvers.
  const resolvers = await loadResolvers(upgradeImpl, upgradeRest);

  const autoUpdate: TransientValue[] = [];
  const modifiedSchema: TransientValue[] = [];
  const lostSchema: TransientValue[] = [];

  const deletedSchemaEntries = new Map(
    [...diff.deleted, ...diff.cascadeDeleted].filter((e) => e.kind === "schema").map((e) => [e.name, e] as const),
  );
  for (const [name, entry] of deletedSchemaEntries) {
    // Existing instances are still stored under the pre-deletion shape — roles
    // come from the snapshot's before-schema, the only one that still exists.
    const oldSchema = entry.before as unknown as NormalizedSchema | null;
    const roles = oldSchema ? derivePropertyRoles(oldSchema) : NO_ROLES;
    for (const instance of await impl.listInstances(rest, name, roles)) lostSchema.push(cloneUpgrade(instance));
  }

  for (const entry of diff.changed) {
    if (entry.kind !== "schema" || entry.before === null || entry.after === null) continue; // pure additions: nothing existing to check
    const oldSchema = entry.before as unknown as NormalizedSchema;
    const newSchema = entry.after as unknown as NormalizedSchema;
    const instances = await impl.listInstances(rest, entry.name, derivePropertyRoles(oldSchema));
    const classified = classifySchemaInstances(oldSchema, newSchema, instances, resolvers.ctx);
    autoUpdate.push(...classified.autoUpdate);
    modifiedSchema.push(...classified.modifiedSchema);
  }

  return { autoUpdate, modifiedSchema, lostSchema };
}

function backfillInstance(
  oldSchema: NormalizedSchema,
  newSchema: NormalizedSchema,
  instance: TransientObject,
  ctx: TypeResolutionContext,
  datasetValue: TransientValue,
): TransientObject | null {
  const oldProps = new Set(oldSchema.properties.filter(isOwnProperty).map((p) => p.name));
  const newProps = new Map(newSchema.properties.filter(isOwnProperty).map((p) => [p.name, p] as const));
  const added = [...newProps.keys()].filter((n) => !oldProps.has(n));
  const removed = [...oldProps].filter((n) => !newProps.has(n));
  if (added.length === 0 && removed.length === 0) return null;

  const result: TransientObject = { ...instance };
  for (const name of removed) delete result[name];
  for (const name of added) {
    const prop = newProps.get(name) as NormalizedProperty;
    const resolved = resolveType(prop.type, ctx);
    // `newSchema` is what a backfilled property belongs to, so `${this.schema...}`
    // in its default_value reads the schema the property was added to.
    result[name] = computePropertyValue(prop, false, undefined, resolved, result, newSchema, datasetValue);
  }
  return result;
}

/**
 * Applies every automatic change recorded in `upgradeLocator` to the dataset
 * at `locator`: backfills every instance `checkUpgrade` would put in
 * `autoUpdate`, replaces/removes the changed `schema`/`scalar_type`
 * definitions, and bumps `model_minor_version` (plus `data_minor_version` if
 * any instance was actually touched). Rejects outright — `incompatible_upgrade`
 * — if `checkUpgrade` would report any `modifiedSchema`/`lostSchema` entries,
 * per document_part-definition-model_upgrade.md's "If the change is
 * incompatible, it is rejected." See `docs/model-upgrade.md` and the
 * `incompatible_upgrade` doc comment of `ErrorCode`.
 */
export async function upgradeDataset(locator: string, upgradeLocator: string): Promise<CommandResult> {
  const { impl, rest } = resolveImpl(locator);
  if (!(await impl.datasetExists(rest))) throw modelError("dataset_not_found", `no dataset at "${locator}"`);
  const { impl: upgradeImpl, rest: upgradeRest, marker } = await requireUpgradeLocator(upgradeLocator);
  if (marker.source_locator !== locator) {
    throw modelError("not_upgrade_locator", `"${upgradeLocator}" was not created for "${locator}"`);
  }

  const check = await checkUpgrade(locator, upgradeLocator);
  if (check.modifiedSchema.length > 0 || check.lostSchema.length > 0) {
    throw modelError(
      "incompatible_upgrade",
      `upgrade rejected: ${check.modifiedSchema.length} instance(s) with a modified schema and ${check.lostSchema.length} instance(s) with a lost schema — resolve outside the modelling language first`,
    );
  }

  const diff = await computeModelDiff(upgradeImpl, upgradeRest);
  const upgradeResolvers = await loadResolvers(upgradeImpl, upgradeRest);
  const datasetValue = await impl.getDataset(rest);

  const before: TransientValue[] = [];
  const after: TransientValue[] = [];
  for (const entry of diff.changed) {
    if (entry.kind !== "schema" || entry.before === null || entry.after === null) continue;
    const oldSchema = entry.before as unknown as NormalizedSchema;
    const newSchema = entry.after as unknown as NormalizedSchema;
    const keyProp = keyPropertyName(newSchema);
    if (!keyProp) continue; // embedded — never a command target, nothing stored under its own name
    // Reading pre-backfill instances: they're still stored under the old
    // shape. Writing backfilled instances: they now conform to the new one.
    const oldRoles = derivePropertyRoles(oldSchema);
    const newRoles = derivePropertyRoles(newSchema);
    for (const raw of await impl.listInstances(rest, entry.name, oldRoles)) {
      const backfilled = backfillInstance(oldSchema, newSchema, raw as TransientObject, upgradeResolvers.ctx, datasetValue);
      if (!backfilled) continue;
      before.push(cloneUpgrade(raw));
      await impl.putInstance(rest, entry.name, backfilled[keyProp] as string, backfilled, newRoles);
      after.push(cloneUpgrade(backfilled));
    }
  }

  for (const entry of [...diff.changed, ...diff.deleted]) {
    // entry.kind is "schema"/"scalar_type" here — writing the definition
    // itself back into the real dataset's model store, so the roles are the
    // `schema` meta-schema's own, never a data schema's.
    if (entry.after !== null) {
      await impl.putInstance(rest, entry.kind, entry.name, entry.after, entry.kind === "schema" ? SCHEMA_ROLES : NO_ROLES);
    } else {
      try {
        await impl.deleteInstance(rest, entry.kind, entry.name);
      } catch {
        // already gone — nothing left to remove
      }
    }
  }
  // Cascade-deleted entries (extending a modified/deleted schema) are only
  // ever "considered as deleted" for reporting — their own stored definition
  // didn't change, so nothing is written back for them here.

  // an extension added to a populated dataset lacks an instance for each instance it extends
  const createdExtensions = await ensureExtensionInstances(impl, rest, upgradeResolvers, datasetValue);

  const patch: TransientObject = { updated_at: new Date().toISOString() };
  const info = (await impl.getDataset(rest)) as TransientObject;
  patch.model_minor_version = (typeof info.model_minor_version === "number" ? info.model_minor_version : 0) + 1;
  if (after.length > 0 || createdExtensions > 0) {
    patch.data_minor_version = (typeof info.data_minor_version === "number" ? info.data_minor_version : 0) + 1;
  }
  await impl.updateDataset(rest, patch);

  // The upgrade locator has done its job — its snapshot/marker and the model
  // copy it held were only ever scratch for this round-trip. Leaving it
  // around after a successful upgrade is pure leftover: invisible for an
  // in-memory format (a dangling entry in a module-scoped registry) but a
  // real orphaned dataset — a folder on disk, for a file-backed format like
  // `obsidian` — otherwise.
  await upgradeImpl.deleteDataset(upgradeRest);

  return { before, after, "cascade-deleted": [], "updated-before": [], "updated-after": [] };
}

// ---------------------------------------------------------------------------
// Commands and scripts
// ---------------------------------------------------------------------------

function isNoopDatasetRename(command: { kind: string; schema: string }, result: CommandResult): boolean {
  if (command.schema !== "dataset" || command.kind !== "update") return false;
  if (result.before.length === 0 || result.after.length === 0) return false;
  return (result.before[0] as TransientObject).name === (result.after[0] as TransientObject).name;
}

/**
 * Runs one command against the dataset at `locator` and returns its result; a command that writes data bumps the data minor version.
 * Throws `unknown_persistent_format`, `dataset_not_found`, `not_upgrade_locator`, `upgrade_locator`, and any Command or Filter exception.
 * See `docs/commands.md`.
 */
export async function runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult> {
  const { impl, rest } = resolveImpl(locator);
  const resolved = resolveCommandForm(command) as unknown as Command;
  return withLock(impl, rest, async () => {
    const resolvers = await loadResolvers(impl, rest);
    const result = await runCommandEngine(impl, rest, resolved, resolvers);
    if (resolved.kind !== "query" && !isModelSchema(resolved.schema) && !isNoopDatasetRename(resolved, result)) await bumpVersion(impl, rest, "data_minor_version");
    return result;
  });
}

/**
 * Runs the commands of `script` in order against the dataset at `locator` and returns the result of the last one;
 * a command names its result with `as` for later placeholders. Throws what `runCommand` throws, and `unknown_reference`.
 */
export async function runScript(locator: string, script: AuthoredScript): Promise<CommandResult> {
  const { impl, rest } = resolveImpl(locator);
  const resolvedCommands = script.commands.map((c) => resolveCommandForm(c) as unknown as ScriptCommand);
  return withLock(impl, rest, async () => {
    const resolvers = await loadResolvers(impl, rest);
    const resolvedScript: Script = { commands: resolvedCommands };
    const result = await runScriptEngine(impl, rest, resolvedScript, async () => resolvers);
    if (resolvedCommands.some((c) => c.kind !== "query" && !isModelSchema(c.schema))) await bumpVersion(impl, rest, "data_minor_version");
    return result;
  });
}

/**
 * Opens a `ScriptSession` against `locator` — the incremental counterpart to
 * `runScript` above, for a caller (today: `@scfloworg/repl`) that wants to
 * run one `ScriptCommand` at a time, over an open-ended period, rather than a
 * complete `Script` in one call. See script.ts's `createScriptSession`.
 *
 * `resolvers` (schemas/scalar_types) are loaded once, when the session opens
 * — a model change on this same locator is not picked up by later `run()`
 * calls on this session. A caller that needs a fresh model opens a fresh
 * session (the REPL's `:new`/`:use` does).
 *
 * Unlike `runScript`'s single bump for the whole script, each `run()` call
 * here bumps `data_minor_version` on its own if it wasn't a `query` — every
 * separately-typed command is its own change, not a batch.
 */
export async function createScriptSession(locator: string): Promise<ScriptSession> {
  const { impl, rest } = resolveImpl(locator);
  const resolvers = await loadResolvers(impl, rest);
  const session = await createScriptSessionEngine(impl, rest, async () => resolvers);
  return {
    variables: session.variables,
    run(scriptCommand: ScriptCommand): Promise<CommandResult> {
      return withLock(impl, rest, async () => {
        const result = await session.run(scriptCommand);
        if (scriptCommand.kind !== "query" && !isModelSchema(scriptCommand.schema)) await bumpVersion(impl, rest, "data_minor_version");
        return result;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Observable notifications — module-level registry, independent of
// any ApiSession. Keyed by locator alone; a listener may register before a
// dataset exists at that locator, or after one has been deleted, and stays
// registered. Survives restoreDataset (an Open), not just set up after one.
// ---------------------------------------------------------------------------

const observableListeners = new Map<string, Set<ObservableListener>>();

/**
 * Registers `listener` for the changes of `observable` schemas at `locator`, independent of any session, and returns the function that unregisters it.
 * The registration may precede the dataset. See `docs/observability.md`.
 */
export function subscribeObservable(locator: string, listener: ObservableListener): () => void {
  let listeners = observableListeners.get(locator);
  if (!listeners) {
    listeners = new Set();
    observableListeners.set(locator, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = observableListeners.get(locator);
    if (current) {
      current.delete(listener);
      if (current.size === 0) observableListeners.delete(locator);
    }
  };
}

function notifyObservable(locator: string, change: ObservableChange): void {
  const listeners = observableListeners.get(locator);
  if (!listeners || listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // Listener threw — continue notifying others
    }
  }
}

/**
 * Filters a transaction's delta map to only include entries for schemas
 * carrying the `observable` constraint, and adds related-change entries
 * for instances whose `observable`-marked relations point at changed targets
 * Returns the filtered delta in the ObservableDelta format
 * (before/after as `null` rather than `undefined` for create/delete).
 * Dataset changes (schema="dataset", key="dataset") are excluded: a dataset
 * patch is not reported to subscribeObservable.
 */
async function filterObservableDelta(
  entries: DeltaEntry[],
  resolvers: Resolvers,
  impl: PersistenceInterface,
  rest: string,
): Promise<ObservableDelta> {
  const result: ObservableDelta = [];
  const directlyTouched = new Set<string>();
  
  // First pass: collect directly-touched entries
  for (const entry of entries) {
    // Exclude dataset changes from observable notifications
    if (entry.schema === "dataset" && entry.key === "dataset") continue;
    
    const schema = resolvers.schemas.get(entry.schema);
    if (!schema || schema.constraints.observable !== true) continue;
    
    const mapKey = `${entry.schema}::${entry.key}`;
    directlyTouched.add(mapKey);
    
    result.push({
      schema: entry.schema,
      key: entry.key,
      before: entry.before === undefined ? null : entry.before,
      after: entry.after === undefined ? null : entry.after,
    });
  }
  
  // Second pass: find related-change entries via observable relations
  // Build a map of changed (schema, key) pairs for quick lookup
  const changedTargets = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!changedTargets.has(entry.schema)) {
      changedTargets.set(entry.schema, new Set());
    }
    changedTargets.get(entry.schema)!.add(entry.key);
  }
  
  // For each observable schema with observable relations, check if any
  // instances point at changed targets
  for (const [schemaName, schema] of resolvers.schemas) {
    if (schema.constraints.observable !== true) continue;
    
    // Find observable relation properties on this schema
    const observableRelations: Array<{ propName: string; targetSchema: string }> = [];
    for (const prop of schema.properties) {
      if (prop.constraints.observable !== true) continue;
      const resolved = resolveType(prop.type, resolvers.ctx);
      if (resolved.kind === "relation") {
        observableRelations.push({ propName: prop.name, targetSchema: prop.type });
      }
    }
    
    if (observableRelations.length === 0) continue;
    
    // Check each instance of this schema
    const keyProp = keyPropertyName(schema);
    if (!keyProp) continue;
    
    const roles = derivePropertyRoles(schema);
    const instances = await impl.listInstances(rest, schemaName, roles);
    
    for (const raw of instances) {
      const instance = raw as TransientObject;
      const instanceKey = instance[keyProp] as string;
      const mapKey = `${schemaName}::${instanceKey}`;
      
      // Skip if this instance was directly touched
      if (directlyTouched.has(mapKey)) continue;
      
      // Check each observable relation
      for (const { propName, targetSchema } of observableRelations) {
        const relationValue = instance[propName];
        
        // Check if this relation points at a changed target
        const targetKeys = changedTargets.get(targetSchema);
        if (!targetKeys) continue;
        
        let pointsAtChangedTarget = false;
        if (typeof relationValue === "string" && targetKeys.has(relationValue)) {
          pointsAtChangedTarget = true;
        } else if (Array.isArray(relationValue)) {
          for (const key of relationValue) {
            if (typeof key === "string" && targetKeys.has(key)) {
              pointsAtChangedTarget = true;
              break;
            }
          }
        }
        
        if (pointsAtChangedTarget) {
          // Add a related-change entry with via
          result.push({
            schema: schemaName,
            key: instanceKey,
            before: cloneUpgrade(instance),
            after: cloneUpgrade(instance),
            via: propName,
          });
          // Mark as added so we don't add it again for another relation
          directlyTouched.add(mapKey);
          break; // Only one via entry per instance
        }
      }
    }
  }
  
  return result;
}

// ---------------------------------------------------------------------------
// ApiSession (usage in `docs/sessions.md`): the sessions of the free
// functions, plus the transaction and revert methods and session queue. The
// caching counterpart to runCommand/runScript/createScriptSession above:
// every method takes the same arguments, returns the same results, and
// throws the same exceptions as its free-function counterpart — the only
// difference is where the Resolvers used to process the command come from,
// and that every operation touching storage or transaction state runs
// through the session's per-locator queue. Transactions and revert have no
// free-function counterpart at all: they need a place to hold state between
// calls, which only an ApiSession offers.
// ---------------------------------------------------------------------------

/** Opaque; only meaningful to the `ApiSession` that issued it. */
export type TransactionId = string;

/** A dataset's four version numbers. */
export interface DatasetVersions {
  model_major_version: number;
  model_minor_version: number;
  data_major_version: number;
  data_minor_version: number;
}

/**
 * Opaque, JSON-serializable and immutable. Carries no reference to the
 * session or the transaction that produced it; a caller stores it, serializes
 * it and hands it back to `ApiSession.revert`. Its structure is not part of
 * the contract. It is meaningful only against the dataset it came from:
 * `revert` checks the dataset's versions, not its identity.
 */
export type Delta = TransientValue;

/** What `prepareTransaction` resolves to. */
export interface PreparedTransaction {
  /** False when the transaction changed nothing; `delta` is then empty. */
  changed: boolean;
  delta: Delta;
  /** The versions the dataset has once the transaction is finalized. */
  versions: DatasetVersions;
}

/**
 * Runs commands and scripts like the free functions, caching each locator's `Resolvers`, and holds transactions, deltas and `revert`.
 * See `docs/sessions.md`.
 */
export interface ApiSession {
  runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult>;
  runScript(locator: string, script: AuthoredScript): Promise<CommandResult>;
  createScriptSession(locator: string): Promise<ScriptSession>;
  /**
   * Drops `locator`'s cached `Resolvers`, so the next call against it loads
   * the model fresh; a no-op for a `locator` this session never cached. A
   * `ScriptSession` already open against `locator` picks the reload up too —
   * its lookup runs once per `run()`, against this same cache. Also rolls
   * back `locator`'s open transaction, if any: a session told its view of a
   * locator may be stale can no longer trust the writes it captured for it.
   * The rollback itself is storage I/O and so asynchronous even though this
   * method isn't — it's queued to run, and guaranteed to finish before any
   * later call this session
   * makes against the same `locator`, but not necessarily before
   * `invalidate` itself returns.
   */
  invalidate(locator: string): void;

  // -------------------------------------------------------------------------
  // Transactions and revert — see `docs/sessions.md`.
  // The engine is generic across every capable format. Deltas are captured
  // at the storage layer, not read from a command's CommandResult: every
  // `putInstance`/`deleteInstance` that reaches the PersistenceInterface
  // while a transaction is open on its locator is recorded, whatever
  // produced it (the command's own instance, a cascade-deleted one, an
  // owner's field written by a detach, a script spanning several schemas).
  // See wrapForDeltaCapture below.
  // -------------------------------------------------------------------------

  /** Whether `locator`'s persistent format permits the rest of this section to run against it. */
  supportsTransactions(locator: string): Promise<boolean>;
  /**
   * Opens a transaction on `locator`, or deepens the one already open and
   * returns its id. `label` is an informational tag (an entry of a UI history
   * list, say) with no role in nesting, delta or revert.
   */
  beginTransaction(locator: string, label?: string): Promise<TransactionId>;
  /**
   * The failable phase of the outermost commit, per the spec's "Two-phase
   * commit". Accepted only at depth one; once it succeeds the transaction is
   * prepared: it refuses commands, `revert` and a nested begin, and accepts
   * only `commitTransaction` (which then cannot fail) or
   * `rollbackTransaction`. Resolves to the transaction's delta and to the
   * versions the dataset will have once finalized, so a caller can use both
   * inside its own batch before the commit.
   */
  prepareTransaction(locator: string, transactionId: TransactionId): Promise<PreparedTransaction>;
  /** An outermost commit on a transaction not yet prepared runs the prepare phase first; it can fail only there. */
  commitTransaction(locator: string, transactionId: TransactionId): Promise<void>;
  rollbackTransaction(locator: string, transactionId: TransactionId): Promise<void>;
  /**
   * Applies the inverse of `delta` inside the open transaction on `locator`,
   * per the spec's "REVERT". Throws `stale_delta` when the dataset's versions
   * differ from those the delta embeds, which makes a revert the first change
   * of its transaction; nothing is written then. It writes the stored
   * instances directly and never replays a command, so it neither
   * re-validates against the current model nor re-triggers side effects. It is
   * one data change: the minor data version moves once, unless the delta is
   * empty, which changes nothing.
   */
  revert(locator: string, delta: Delta): Promise<void>;

  // -------------------------------------------------------------------------
  // Dataset functions through the session queue — the spec's "SESSION QUEUE".
  // Same arguments, results and exceptions as the free functions; queued
  // behind every earlier operation this session runs against `locator`.
  // -------------------------------------------------------------------------

  queryDataset(locator: string): Promise<TransientValue>;
  dumpDataset(locator: string, format: "json" | "yaml"): Promise<string>;
  /** Also drops the locator's cache and rolls back its open transaction, as `invalidate` does, before deleting. */
  deleteDataset(locator: string): Promise<TransientValue>;
}

// ---------------------------------------------------------------------------
// Transaction engine internals — module-private, shared by every ApiSession
// (each session's own state lives in createApiSession's closure below; these
// are stateless helpers over that state).
// ---------------------------------------------------------------------------

/**
 * One (schema, key)'s net change within a still-open or already-committed
 * transaction. `before`/`after` are `undefined` — rather than `null`, a
 * legitimate stored value — for "this key didn't exist": created (nothing to
 * revert to but deletion) or deleted (nothing to apply but deletion),
 * respectively.
 */
interface DeltaEntry {
  schema: string;
  key: Key;
  before: TransientValue | undefined;
  after: TransientValue | undefined;
}

/** An `ApiSession`'s cached model of one locator, with the model versions it was loaded under. */
interface CachedModel {
  modelVersions: string;
  resolvers: Resolvers;
}

/** A locator's currently-open transaction, tracked as a depth counter per the spec's "Nesting". */
interface OpenTransaction {
  id: TransactionId;
  depth: number;
  label?: string;
  /** Keyed by `${schema}::${key}` — collapses repeated touches to the same instance into one net entry. */
  delta: Map<string, DeltaEntry>;
  /**
   * Set by the prepare phase. Carries everything the finalize phase needs
   * that could still fail to compute — the observable delta and the
   * prepared result — so that finalizing only moves state and notifies.
   */
  prepared?: { observableDelta: ObservableDelta; result: PreparedTransaction };
  /**
   * The dataset's four versions and `updated_at` at the outermost begin. The
   * engine bumps versions outside the delta, so a rollback restores them from
   * here: a rolled-back transaction never took effect.
   */
  versionsAtBegin: TransientObject;
  /**
   * Releases the write lock taken at the outermost begin, when the format
   * provides one. Held until the transaction commits or rolls back, so every
   * command run inside it is already under the lock.
   */
  release?: () => Promise<void>;
}

let transactionIdCounter = 0;

function newTransactionId(): TransactionId {
  transactionIdCounter += 1;
  return `tx_${transactionIdCounter}`;
}

/**
 * One (schema, key) touch's net effect within a still-open transaction —
 * shared by every call site, since delta capture happens once, at the
 * storage layer (see wrapForDeltaCapture below), not per CommandResult
 * shape. A second touch of the same (schema, key) keeps the earliest
 * `before` and the latest `after`; a touch that nets out to no change at
 * all — created then deleted within the same transaction — drops the entry
 * entirely, as `docs/sessions.md` (Delta and revert) states.
 */
function touchDelta(state: OpenTransaction, schema: string, key: Key, before: TransientValue | undefined, after: TransientValue | undefined): void {
  const mapKey = `${schema}::${key}`;
  const existing = state.delta.get(mapKey);
  if (existing) {
    existing.after = after;
    if (existing.before === undefined && existing.after === undefined) state.delta.delete(mapKey);
  } else if (!(before === undefined && after === undefined)) {
    state.delta.set(mapKey, { schema, key, before, after });
  }
}

/**
 * Wraps `impl` so every real `putInstance`/`deleteInstance` call it sees is
 * captured into `locator`'s currently open transaction, if any — checked
 * fresh on every call (`openTx.get(locator)`, not decided once at wrap
 * time), so the same wrapped impl is safe to hand to a long-lived
 * `ScriptSession` whose individual `run()` calls may straddle a transaction
 * being opened or closed in between. This is what makes delta capture
 * generic across whatever produced the write — command.ts's own instance, a
 * cascade delete, detachFromOwner's write to an owner's own field on a
 * completely different schema — rather than tied to one command's own
 * primary schema, per the ApiSession interface's "Transactions and
 * "Transactions and revert" comment above. Every other PersistenceInterface member passes
 * straight through, unwrapped.
 *
 * `getResolversFor` is only needed for `deleteInstance`, to derive the
 * schema's `propertyRoles` for the pre-delete `getInstance` read the same
 * way `applyEntries` does when it later replays this entry — `putInstance`
 * calls always carry their own `propertyRoles` already, so no lookup is
 * needed there.
 */
function wrapForDeltaCapture(
  impl: PersistenceInterface,
  locator: string,
  openTx: Map<string, OpenTransaction>,
  getResolversFor: () => Promise<Resolvers>,
): PersistenceInterface {
  return {
    name: impl.name,
    supportsTransactions: impl.supportsTransactions,
    areaOf: (rest) => impl.areaOf(rest),
    builtinRestFor: (rest) => impl.builtinRestFor(rest),
    datasetExists: (rest) => impl.datasetExists(rest),
    createDataset: (rest, name) => impl.createDataset(rest, name),
    getDataset: (rest) => impl.getDataset(rest),
    deleteDataset: (rest) => impl.deleteDataset(rest),
    getInstance: (rest, schema, key, propertyRoles) => impl.getInstance(rest, schema, key, propertyRoles),
    listInstances: (rest, schema, propertyRoles) => impl.listInstances(rest, schema, propertyRoles),

    async updateDataset(rest, patch) {
      const state = openTx.get(locator);
      if (!state) {
        return impl.updateDataset(rest, patch);
      }
      // Only capture name changes in the delta - versions/timestamps are
      // bumped by the engine and must move forward on revert, not restore
      // old values
      const patchObj = patch as TransientObject;
      if (Object.prototype.hasOwnProperty.call(patchObj, "name")) {
        const current = (await impl.getDataset(rest)) as TransientObject;
        const currentName = current.name;
        const result = await impl.updateDataset(rest, patch);
        const resultObj = result as TransientObject;
        const newName = resultObj.name;
        // Only record a delta if the name actually changed
        if (currentName !== newName) {
          touchDelta(
            state,
            "dataset",
            "dataset",
            { name: currentName },
            { name: newName },
          );
        }
        return result;
      }
      // Version-only patch (no name change) - no delta entry
      return impl.updateDataset(rest, patch);
    },

    async putInstance(rest, schema, key, instance, propertyRoles) {
      const state = openTx.get(locator);
      if (!state) {
        await impl.putInstance(rest, schema, key, instance, propertyRoles);
        return;
      }
      const existing = await impl.getInstance(rest, schema, key, propertyRoles);
      await impl.putInstance(rest, schema, key, instance, propertyRoles);
      touchDelta(state, schema, key, existing === null ? undefined : cloneUpgrade(existing), cloneUpgrade(instance));
    },

    async deleteInstance(rest, schema, key) {
      const state = openTx.get(locator);
      if (!state) {
        await impl.deleteInstance(rest, schema, key);
        return;
      }
      const resolvers = await getResolversFor();
      const schemaObj = resolvers.schemas.get(schema);
      const propertyRoles = schemaObj ? derivePropertyRoles(schemaObj) : {};
      const existing = await impl.getInstance(rest, schema, key, propertyRoles);
      await impl.deleteInstance(rest, schema, key);
      touchDelta(state, schema, key, existing === null ? undefined : cloneUpgrade(existing), undefined);
    },
  };
}

/**
 * Applies the before-state (`useBefore: true`) or the after-state
 * (`useBefore: false`) of a set of delta entries directly against `impl`.
 * Replays raw `putInstance`/`deleteInstance` calls, never the original
 * Command: replaying the Command could re-validate against a model that has
 * since moved on, or re-trigger side effects already accounted for in the
 * captured delta. Dataset changes (schema="dataset", key="dataset") go
 * through `updateDataset` with the name only: versions and timestamps are
 * bumped by the engine and always move forward. A rollback passes the
 * UNWRAPPED PersistenceInterface so the replay is not captured; `revert`
 * passes the delta-capturing wrapper so the revert joins its transaction's
 * delta.
 */
async function applyEntries(impl: PersistenceInterface, rest: string, resolvers: Resolvers, entries: DeltaEntry[], useBefore: boolean): Promise<void> {
  for (const entry of entries) {
    if (entry.schema === "dataset" && entry.key === "dataset") {
      // Dataset singleton: replay via updateDataset with just the name field
      // (versions/timestamps are bumped by the engine, not restored)
      const value = useBefore ? entry.before : entry.after;
      if (value !== undefined) {
        const valueObj = value as TransientObject;
        await impl.updateDataset(rest, { name: valueObj.name });
      }
      continue;
    }
    
    const value = useBefore ? entry.before : entry.after;
    if (value === undefined) {
      try {
        await impl.deleteInstance(rest, entry.schema, entry.key);
      } catch {
        // Already gone — nothing left to delete.
      }
    } else {
      const schemaObj = resolvers.schemas.get(entry.schema);
      await impl.putInstance(rest, entry.schema, entry.key, value, schemaObj ? derivePropertyRoles(schemaObj) : {});
    }
  }
}

const ZERO_VERSIONS: DatasetVersions = {
  model_major_version: 0,
  model_minor_version: 0,
  data_major_version: 0,
  data_minor_version: 0,
};

/** The dataset's four version numbers, all `0` when no dataset exists at `rest`. */
async function readVersions(impl: PersistenceInterface, rest: string): Promise<DatasetVersions> {
  if (!(await impl.datasetExists(rest))) return { ...ZERO_VERSIONS };
  const info = (await impl.getDataset(rest)) as TransientObject;
  const num = (v: TransientValue | undefined) => (typeof v === "number" ? v : 0);
  return {
    model_major_version: num(info.model_major_version),
    model_minor_version: num(info.model_minor_version),
    data_major_version: num(info.data_major_version),
    data_minor_version: num(info.data_minor_version),
  };
}

const VERSION_FIELDS = ["model_major_version", "model_minor_version", "data_major_version", "data_minor_version"] as const;

function sameVersions(a: DatasetVersions, b: DatasetVersions): boolean {
  return VERSION_FIELDS.every((field) => a[field] === b[field]);
}

function asObject(value: unknown): TransientObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as TransientObject) : null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

const DELTA_FORMAT = 1;

/**
 * The opaque delta of a transaction: its net entries, and the versions the
 * dataset has once the transaction is finalized. An entry omits `before` for
 * an instance the transaction created and `after` for one it deleted, so the
 * delta survives a JSON round trip.
 */
function encodeDelta(entries: DeltaEntry[], versions: DatasetVersions): Delta {
  const encoded: TransientObject[] = entries.map((e) => {
    const entry: TransientObject = { schema: e.schema, key: e.key };
    if (e.before !== undefined) entry.before = cloneUpgrade(e.before);
    if (e.after !== undefined) entry.after = cloneUpgrade(e.after);
    return entry;
  });
  const delta: TransientObject = { format: DELTA_FORMAT, versions: { ...versions }, entries: encoded };
  return deepFreeze(delta);
}

/** Reads back what `encodeDelta` produced; anything else throws `invalid_delta`. The entries it returns are fresh copies. */
function decodeDelta(delta: Delta): { versions: DatasetVersions; entries: DeltaEntry[] } {
  const invalid = () => modelError("invalid_delta", "the value is not a delta returned by prepareTransaction");
  const obj = asObject(delta);
  const versionsObj = obj ? asObject(obj.versions) : null;
  if (!obj || obj.format !== DELTA_FORMAT || !versionsObj || !Array.isArray(obj.entries)) throw invalid();
  const versions = { ...ZERO_VERSIONS };
  for (const field of VERSION_FIELDS) {
    const n = versionsObj[field];
    if (typeof n !== "number") throw invalid();
    versions[field] = n;
  }
  const entries: DeltaEntry[] = [];
  for (const raw of obj.entries) {
    const e = asObject(raw);
    if (!e || typeof e.schema !== "string" || typeof e.key !== "string") throw invalid();
    const hasBefore = e.before !== undefined;
    const hasAfter = e.after !== undefined;
    if (!hasBefore && !hasAfter) throw invalid();
    if ((hasBefore && !asObject(e.before)) || (hasAfter && !asObject(e.after))) throw invalid();
    entries.push({
      schema: e.schema,
      key: e.key,
      before: hasBefore ? cloneUpgrade(e.before as TransientValue) : undefined,
      after: hasAfter ? cloneUpgrade(e.after as TransientValue) : undefined,
    });
  }
  return { versions, entries };
}

/**
 * Creates an `ApiSession`. Caching: the first call against a given
 * `locator`, through any method below, loads and keeps that locator's
 * `Resolvers` for the life of the session; every later call against the same
 * `locator`, through this same session, reuses them — including a
 * `ScriptSession` this session opens later, or a `runCommand`/`runScript`
 * call made in between two of that `ScriptSession`'s `run()` calls. Each
 * entry carries the `model_major_version`/`model_minor_version` pair it was
 * loaded under, and every call that uses the model compares it with the
 * dataset's current pair first, reloading when they differ: a model change
 * made by another session, caller or upgrade is seen by the next call, at the
 * cost of one dataset read. `invalidate` drops an entry at once for a caller
 * that makes the change itself.
 *
 * The cache is a `Map<locator, Promise<CachedModel>>` rather than a map of
 * plain values so that two calls against the same locator
 * arriving before the first `loadResolvers` has resolved still share the one
 * in-flight load instead of racing to start a second.
 *
 * Every method below that touches storage or transaction state runs through
 * `serialize`, the per-locator queue of the spec's "SESSION QUEUE": each such
 * call waits for any earlier one against the same locator to settle before
 * it starts, and a failed call does not stop the queue. This covers a caller
 * that does not await one call before making the next, `invalidate`'s
 * unawaited rollback, and the session's own `queryDataset`/`dumpDataset`/
 * `deleteDataset`, which would otherwise read or act on an intermediate
 * state.
 */
export function createApiSession(): ApiSession {
  const resolversCache = new Map<string, Promise<CachedModel>>();
  const openTx = new Map<string, OpenTransaction>();
  const pending = new Map<string, Promise<void>>();

  async function modelVersionsOf(impl: PersistenceInterface, rest: string): Promise<string> {
    const info = (await impl.getDataset(rest)) as TransientObject;
    return `${info.model_major_version}.${info.model_minor_version}`;
  }

  // The versions are read before the model, so a change landing in between
  // leaves the entry stamped with the older pair and the next call reloads it.
  async function loadModel(impl: PersistenceInterface, rest: string): Promise<CachedModel> {
    const modelVersions = await modelVersionsOf(impl, rest);
    return { modelVersions, resolvers: await loadResolvers(impl, rest) };
  }

  async function getResolvers(impl: PersistenceInterface, rest: string, locator: string): Promise<Resolvers> {
    let cached = resolversCache.get(locator);
    if (!cached) {
      cached = loadModel(impl, rest);
      resolversCache.set(locator, cached);
    }
    return (await cached).resolvers;
  }

  /**
   * Drops `locator`'s cached model when the dataset's model versions are no
   * longer the pair it was loaded under, so a change made by another session,
   * caller or upgrade is seen by this call. Called once at the start of each
   * call that uses the model; a locator never cached costs nothing.
   */
  async function revalidateModel(impl: PersistenceInterface, rest: string, locator: string): Promise<void> {
    const cached = resolversCache.get(locator);
    if (!cached) return;
    let loadedUnder: string;
    try {
      loadedUnder = (await cached).modelVersions;
    } catch {
      if (resolversCache.get(locator) === cached) resolversCache.delete(locator);
      return;
    }
    if ((await modelVersionsOf(impl, rest)) !== loadedUnder && resolversCache.get(locator) === cached) resolversCache.delete(locator);
  }

  function serialize<T>(locator: string, fn: () => Promise<T>): Promise<T> {
    const prior = pending.get(locator) ?? Promise.resolve();
    const run = prior.then(fn);
    pending.set(
      locator,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async function requireDataset(impl: PersistenceInterface, rest: string, locator: string): Promise<void> {
    if (!(await impl.datasetExists(rest))) throw modelError("dataset_not_found", `no dataset at "${locator}"`);
  }

  function requireTransactionCapability(impl: PersistenceInterface, locator: string): void {
    if (impl.supportsTransactions !== true) {
      throw modelError("transactions_not_supported", `"${locator}"'s persistent format does not support transactions`);
    }
  }

  function requireOpenTransaction(locator: string, transactionId: TransactionId): OpenTransaction {
    const state = openTx.get(locator);
    if (!state) throw modelError("no_transaction_in_progress", `no transaction is open on "${locator}"`);
    if (state.id !== transactionId) {
      throw modelError("transaction_id_mismatch", `"${transactionId}" is not the currently open transaction on "${locator}"`);
    }
    return state;
  }

  /**
   * Runs `fn` under the format's write lock, unless an open transaction on
   * `locator` already holds it: the lock is taken once at the outermost
   * `beginTransaction` and covers every command run inside the transaction.
   */
  function withWriteLock<T>(locator: string, impl: PersistenceInterface, rest: string, fn: () => Promise<T>): Promise<T> {
    if (openTx.has(locator)) return fn();
    return withLock(impl, rest, fn);
  }

  /** Releases the lock a transaction took at its outermost begin, once, whichever way the transaction ends. */
  async function releaseTransactionLock(state: OpenTransaction): Promise<void> {
    const release = state.release;
    state.release = undefined;
    if (release) await release();
  }

  /** Throws `transaction_prepared` when `locator`'s open transaction is prepared — shared by every entry point a prepared transaction refuses. */
  function refuseIfPrepared(locator: string): void {
    if (openTx.get(locator)?.prepared) {
      throw modelError("transaction_prepared", `the transaction open on "${locator}" is already prepared`);
    }
  }

  /**
   * Undoes every change an abandoned or rolled-back transaction made,
   * against the unwrapped store, and restores the versions and `updated_at`
   * recorded at its outermost begin (the spec's "Nesting").
   */
  async function rollbackState(locator: string, impl: PersistenceInterface, rest: string, state: OpenTransaction): Promise<void> {
    const resolvers = await getResolvers(impl, rest, locator);
    await applyEntries(impl, rest, resolvers, [...state.delta.values()], true);
    await impl.updateDataset(rest, state.versionsAtBegin);
  }

  /**
   * The prepare phase proper, reached only at depth one: computes everything
   * the finalize phase needs that can still fail — the observable delta, the
   * transaction's delta and the versions the dataset will have — and marks
   * the transaction prepared. The commands' writes have already reached
   * storage as each ran, so there is nothing left to write here.
   */
  async function prepare(locator: string, impl: PersistenceInterface, rest: string, state: OpenTransaction): Promise<PreparedTransaction> {
    const entries = [...state.delta.values()];
    let observableDelta: ObservableDelta = [];
    if (entries.length > 0) {
      const resolvers = await getResolvers(impl, rest, locator);
      observableDelta = await filterObservableDelta(entries, resolvers, impl, rest);
    }
    const versions = await readVersions(impl, rest);
    const result: PreparedTransaction = { changed: entries.length > 0, delta: encodeDelta(entries, versions), versions: { ...versions } };
    state.prepared = { observableDelta, result };
    return result;
  }

  return {
    runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult> {
      return serialize(locator, async () => {
        refuseIfPrepared(locator);
        const { impl, rest } = resolveImpl(locator);
        return withWriteLock(locator, impl, rest, async () => {
          await revalidateModel(impl, rest, locator);
          const resolvers = await getResolvers(impl, rest, locator);
          const resolved = resolveCommandForm(command) as unknown as Command;
          const deltaImpl = wrapForDeltaCapture(impl, locator, openTx, () => getResolvers(impl, rest, locator));
          const result = await runCommandEngine(deltaImpl, rest, resolved, resolvers);
          if (resolved.kind !== "query" && !isModelSchema(resolved.schema) && !isNoopDatasetRename(resolved, result)) await bumpVersion(impl, rest, "data_minor_version");
          return result;
        });
      });
    },

    runScript(locator: string, script: AuthoredScript): Promise<CommandResult> {
      return serialize(locator, async () => {
        refuseIfPrepared(locator);
        const { impl, rest } = resolveImpl(locator);
        const resolvedCommands = script.commands.map((c) => resolveCommandForm(c) as unknown as ScriptCommand);
        return withWriteLock(locator, impl, rest, async () => {
          await revalidateModel(impl, rest, locator);
          const resolvedScript: Script = { commands: resolvedCommands };
          const deltaImpl = wrapForDeltaCapture(impl, locator, openTx, () => getResolvers(impl, rest, locator));
          const result = await runScriptEngine(deltaImpl, rest, resolvedScript, () => getResolvers(impl, rest, locator));
          if (resolvedCommands.some((c) => c.kind !== "query" && !isModelSchema(c.schema))) await bumpVersion(impl, rest, "data_minor_version");
          return result;
        });
      });
    },

    async createScriptSession(locator: string): Promise<ScriptSession> {
      refuseIfPrepared(locator);
      const { impl, rest } = resolveImpl(locator);
      const deltaImpl = wrapForDeltaCapture(impl, locator, openTx, () => getResolvers(impl, rest, locator));
      const session = await createScriptSessionEngine(deltaImpl, rest, () => getResolvers(impl, rest, locator));
      return {
        variables: session.variables,
        run(scriptCommand: ScriptCommand): Promise<CommandResult> {
          return serialize(locator, async () => {
            refuseIfPrepared(locator);
            return withWriteLock(locator, impl, rest, async () => {
              await revalidateModel(impl, rest, locator);
              const result = await session.run(scriptCommand);
              if (scriptCommand.kind !== "query" && !isModelSchema(scriptCommand.schema) && !isNoopDatasetRename(scriptCommand, result)) await bumpVersion(impl, rest, "data_minor_version");
              return result;
            });
          });
        },
      };
    },

    invalidate(locator: string): void {
      resolversCache.delete(locator);
      const state = openTx.get(locator);
      openTx.delete(locator);
      if (!state) return;
      void serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        try {
          await rollbackState(locator, impl, rest, state);
        } finally {
          await releaseTransactionLock(state);
        }
      }).catch(() => {
        // Best-effort: this transaction is already abandoned from the
        // caller's point of view (no id left to act on it with) — nothing
        // else to do with a failure reverting it.
      });
    },

    async supportsTransactions(locator: string): Promise<boolean> {
      const { impl, rest } = resolveImpl(locator);
      await requireDataset(impl, rest, locator);
      return impl.supportsTransactions === true;
    },

    beginTransaction(locator: string, label?: string): Promise<TransactionId> {
      return serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        await requireDataset(impl, rest, locator);
        requireTransactionCapability(impl, locator);
        const existing = openTx.get(locator);
        if (existing) {
          refuseIfPrepared(locator);
          existing.depth += 1;
          return existing.id;
        }
        const id = newTransactionId();
        // The lock is taken before the versions are read, so `versionsAtBegin`
        // is what no other writer can change until this transaction ends.
        const release = impl.lock ? await impl.lock(rest) : undefined;
        try {
          const info = (await impl.getDataset(rest)) as TransientObject;
          const versionsAtBegin: TransientObject = {
            model_major_version: info.model_major_version,
            model_minor_version: info.model_minor_version,
            data_major_version: info.data_major_version,
            data_minor_version: info.data_minor_version,
            updated_at: info.updated_at,
          };
          openTx.set(locator, { id, depth: 1, label, delta: new Map(), versionsAtBegin, release });
        } catch (error) {
          await release?.();
          throw error;
        }
        return id;
      });
    },

    prepareTransaction(locator: string, transactionId: TransactionId): Promise<PreparedTransaction> {
      return serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        await requireDataset(impl, rest, locator);
        requireTransactionCapability(impl, locator);
        const state = requireOpenTransaction(locator, transactionId);
        refuseIfPrepared(locator);
        if (state.depth > 1) {
          throw modelError("transaction_not_outermost", `the transaction open on "${locator}" is nested ${state.depth} deep`);
        }
        return prepare(locator, impl, rest, state);
      });
    },

    commitTransaction(locator: string, transactionId: TransactionId): Promise<void> {
      return serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        // A prepared transaction's finalize cannot fail: no storage I/O
        // from here on, only the caller-error checks below.
        if (!openTx.get(locator)?.prepared) await requireDataset(impl, rest, locator);
        requireTransactionCapability(impl, locator);
        const state = requireOpenTransaction(locator, transactionId);
        if (!state.prepared) {
          if (state.depth > 1) {
            state.depth -= 1; // a nested commit — only the outermost one finalizes
            return;
          }
          await prepare(locator, impl, rest, state);
        }
        const prepared = state.prepared as NonNullable<OpenTransaction["prepared"]>;
        state.depth = 0;
        openTx.delete(locator);
        try {
          await releaseTransactionLock(state);
        } finally {
          if (prepared.observableDelta.length > 0) {
            notifyObservable(locator, { kind: "delta", changes: prepared.observableDelta });
          }
        }
      });
    },

    rollbackTransaction(locator: string, transactionId: TransactionId): Promise<void> {
      return serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        await requireDataset(impl, rest, locator);
        requireTransactionCapability(impl, locator);
        const state = requireOpenTransaction(locator, transactionId);
        // "Called at any depth ... discards the whole thing regardless of
        // nesting" — every transactionId handed out for it (they're all the
        // same id) becomes invalid the moment the open transaction is gone.
        // A prepared transaction rolls back the same way.
        openTx.delete(locator);
        try {
          await rollbackState(locator, impl, rest, state);
        } finally {
          await releaseTransactionLock(state);
        }
      });
    },

    revert(locator: string, delta: Delta): Promise<void> {
      return serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        await requireDataset(impl, rest, locator);
        requireTransactionCapability(impl, locator);
        if (!openTx.has(locator)) throw modelError("no_transaction_in_progress", `no transaction is open on "${locator}"`);
        refuseIfPrepared(locator);
        const { versions, entries } = decodeDelta(delta);
        if (!sameVersions(await readVersions(impl, rest), versions)) {
          throw modelError("stale_delta", `the dataset at "${locator}" is not in the state the delta expects`);
        }
        if (entries.length === 0) return;
        await revalidateModel(impl, rest, locator);
        const resolvers = await getResolvers(impl, rest, locator);
        const deltaImpl = wrapForDeltaCapture(impl, locator, openTx, () => getResolvers(impl, rest, locator));
        await applyEntries(deltaImpl, rest, resolvers, entries, true);
        await bumpVersion(impl, rest, "data_minor_version");
      });
    },

    // Inside these three methods, `queryDataset`/`dumpDataset`/`deleteDataset`
    // name the module-level free functions: a method of an object literal
    // creates no binding of its own name.

    queryDataset(locator: string): Promise<TransientValue> {
      return serialize(locator, () => queryDataset(locator));
    },

    dumpDataset(locator: string, format: "json" | "yaml"): Promise<string> {
      return serialize(locator, () => dumpDataset(locator, format));
    },

    deleteDataset(locator: string): Promise<TransientValue> {
      return serialize(locator, async () => {
        const { impl, rest } = resolveImpl(locator);
        const state = openTx.get(locator);
        openTx.delete(locator);
        if (state) {
          try {
            await rollbackState(locator, impl, rest, state);
          } finally {
            await releaseTransactionLock(state);
          }
        }
        resolversCache.delete(locator);
        return deleteDataset(locator);
      });
    },
  };
}

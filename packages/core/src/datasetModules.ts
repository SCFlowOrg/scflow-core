import { MCL_CORE } from "./mclCore.js";
import type { ModuleManifest } from "./mclCore.js";
import { modelError } from "./errors.js";
import { assembleFacets, generatedInverseName } from "./facets.js";
import { validateRules } from "./ruleValidation.js";
import { createModuleSet, validateModuleManifest } from "./modules.js";
import type { ModuleSet } from "./modules.js";
import { NO_ROLES } from "./schemaProcessing.js";
import type {
  NormalizedProperty,
  NormalizedScalarType,
  NormalizedSchema,
  PersistenceInterface,
  TransientObject,
  TransientValue,
} from "./types.js";

/**
 * The modules of a dataset (see `docs/datasets.md`, Modules of a dataset): the
 * `modules` list of the dataset, the manifests embedded with it, their digest,
 * and the model a dataset reads from them.
 */

/** A module a dataset uses, at the version the dataset was written against: an instance of `dataset_module`. */
export interface DatasetModule {
  module: string;
  version: string;
  /** `sha256:` and the lowercase hexadecimal SHA-256 of the canonical form of the embedded manifest. */
  digest: string;
}

/** The store, in a dataset, of the manifests of its modules: instances of `module` by module key. */
export const MODULE_STORE = "module";

/** The publisher of a local module, `local:<name>`: embedded in its dataset, in no catalogue, and editable. */
export const LOCAL_PUBLISHER = "local";

/** Whether `key` names a local module. */
export function isLocalModule(key: string): boolean {
  return key.startsWith(`${LOCAL_PUBLISHER}:`);
}

/**
 * The canonical form of a JSON value: the keys of every object sorted, no white
 * space, a key whose value is `undefined` left out, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The digest of a module: `sha256:` followed by the lowercase hexadecimal
 * SHA-256 of the canonical JSON of its manifest, as `validateModuleManifest`
 * gives it (its defaults set), in UTF-8. Uses the Web Crypto API, present in
 * browsers and in Node 18 and later.
 */
export async function moduleDigest(manifest: ModuleManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(validateModuleManifest(manifest)));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The `dataset_module` entry of `manifest`, already validated. */
export async function datasetModuleOf(manifest: ModuleManifest): Promise<DatasetModule> {
  return { module: manifest.name, version: manifest.version, digest: await moduleDigest(manifest) };
}

/** The `modules` list stored on the dataset at `rest`: `[]` for a dataset that has none. */
export async function readModuleEntries(impl: PersistenceInterface, rest: string): Promise<DatasetModule[]> {
  const info = (await impl.getDataset(rest)) as TransientObject;
  return Array.isArray(info.modules) ? (info.modules as unknown as DatasetModule[]) : [];
}

/** The embedded manifests of the modules of the dataset at `rest`, in the order of its `modules` list. */
export async function readModuleManifests(impl: PersistenceInterface, rest: string, entries?: DatasetModule[]): Promise<ModuleManifest[]> {
  const list = entries ?? (await readModuleEntries(impl, rest));
  return Promise.all(
    list.map(async (entry) => {
      const raw = await impl.getInstance(rest, MODULE_STORE, entry.module, NO_ROLES);
      if (raw === null) throw modelError("key_not_found", `the dataset lists module "${entry.module}" but embeds no manifest for it`);
      return raw as unknown as ModuleManifest;
    }),
  );
}

/**
 * Stores `manifests` as the modules of the dataset at `rest`: each manifest as
 * an instance of `module`, the `modules` list on the dataset, and the manifests
 * of modules no longer listed removed. The manifests are already validated.
 */
export async function writeModules(impl: PersistenceInterface, rest: string, manifests: ModuleManifest[]): Promise<DatasetModule[]> {
  const entries = await Promise.all(manifests.map(datasetModuleOf));
  const kept = new Set(entries.map((e) => e.module));
  for (const raw of await impl.listInstances(rest, MODULE_STORE, NO_ROLES)) {
    const key = (raw as TransientObject).name as string;
    if (!kept.has(key)) await impl.deleteInstance(rest, MODULE_STORE, key);
  }
  for (const manifest of manifests) {
    await impl.putInstance(rest, MODULE_STORE, manifest.name, manifest as unknown as TransientValue, NO_ROLES);
  }
  await impl.updateDataset(rest, { modules: entries as unknown as TransientValue });
  return entries;
}

/**
 * The model a dataset reads from its modules: each schema and scalar type of a
 * module under its key, the qualified name, which is also its `name` here, so
 * that commands and storage name it the same way; the standard scalar types of
 * `mcl:core` under their short names; on the target of each relation with an
 * `inverse_name`, its generated inverse relation, qualified by the namespace of
 * the declaring module when the target belongs to another; and, on the target
 * of each facet and the schemas extending it, the properties of the facet under
 * its namespace (see `facets.ts`).
 */
export interface DatasetModel {
  set: ModuleSet;
  schemas: Map<string, NormalizedSchema>;
  scalarTypes: Map<string, NormalizedScalarType>;
}

/**
 * Builds the model of a dataset from the manifests of its modules. Throws what
 * `createModuleSet` throws, `inverse_name_conflict` when a generated inverse
 * relation would take the name of a declared property, and
 * `constraint_violation` for an `inverse_is_mandatory` across modules and for
 * the rules of a facet that need every schema (see `assembleFacets`).
 */
export function buildDatasetModel(manifests: readonly ModuleManifest[]): DatasetModel {
  const set = createModuleSet(manifests);
  const schemas = new Map<string, NormalizedSchema>();
  const scalarTypes = new Map<string, NormalizedScalarType>();
  for (const type of MCL_CORE.scalar_types) scalarTypes.set(type.name, type);
  for (const module of set.modules) {
    if (module.key === MCL_CORE.name) continue;
    const qualify = (short: string) => `${module.namespace}.${short}`;
    for (const [short, type] of module.scalarTypes) scalarTypes.set(qualify(short), { ...type, name: qualify(short) });
    for (const [short, schema] of module.schemas) schemas.set(qualify(short), { ...schema, name: qualify(short) });
  }
  generateInverseRelations(schemas);
  assembleFacets(schemas);
  // the rules need every schema: their paths cross relations, an `exists` names another schema
  validateRules(schemas, { resolveSchema: (n) => schemas.get(n), resolveScalarType: (n) => scalarTypes.get(n) });
  return { set, schemas, scalarTypes };
}

/** `schema` and every schema extending it, transitively. */
function withExtenders(schemas: Map<string, NormalizedSchema>, name: string): string[] {
  const found = [name];
  for (let i = 0; i < found.length; i++) {
    for (const s of schemas.values()) if (s.extends === found[i] && !found.includes(s.name)) found.push(s.name);
  }
  return found;
}

/**
 * Adds, on the target of each relation with an `inverse_name` and on the
 * schemas extending it, the generated (virtual) inverse relation, as a model
 * upgrade does for the schemas of a dataset. A relation a schema inherits
 * through `extends` generates nothing more: its inverse names the schema that
 * declares it.
 */
function generateInverseRelations(schemas: Map<string, NormalizedSchema>): void {
  for (const name of [...schemas.keys()]) {
    const schema = schemas.get(name) as NormalizedSchema;
    const parent = schema.extends ? schemas.get(schema.extends) : undefined;
    for (const prop of schema.properties) {
      const inverseName = prop.constraints.inverse_name;
      if (typeof inverseName !== "string") continue;
      if (parent?.properties.some((p) => p.name === prop.name && p.constraints.inverse_name === inverseName)) continue;
      if (!schemas.has(prop.type)) continue;
      // across modules the target stays unchanged: the relation is qualified by the declaring module, and optional
      const name = generatedInverseName(schema.name, prop);
      if (name !== inverseName && prop.constraints.inverse_is_mandatory === true) {
        throw modelError("constraint_violation", `"${schema.name}.${prop.name}" has "inverse_is_mandatory" on "${prop.type}" of another module — a virtual relation across modules is optional`);
      }
      const virtual: NormalizedProperty = {
        name,
        type: schema.name,
        default_value: null,
        null_value: null,
        constraints: {
          is_array: prop.constraints.inverse_is_array === true,
          mandatory: prop.constraints.inverse_is_mandatory === true,
          owner: prop.constraints.owns === true,
          __generated: true,
        },
      };
      for (const targetName of withExtenders(schemas, prop.type)) {
        const target = schemas.get(targetName) as NormalizedSchema;
        const existing = target.properties.find((p) => p.name === name);
        if (existing) {
          if (existing.constraints.__generated === true) continue;
          throw modelError("inverse_name_conflict", `"${name}" already exists on "${target.name}" and is not a generated inverse relation`);
        }
        schemas.set(targetName, { ...target, properties: [...target.properties, virtual] });
      }
    }
  }
}

const modelCache = new Map<string, DatasetModel>();
const MODEL_CACHE_SIZE = 32;

/**
 * The model of the dataset at `rest`, or `null` when it uses no module. A model
 * is built once for each list of modules and digests, and kept: a list with the
 * same digests holds the same manifests.
 */
export async function loadDatasetModel(impl: PersistenceInterface, rest: string): Promise<DatasetModel | null> {
  const entries = await readModuleEntries(impl, rest);
  if (entries.length === 0) return null;
  const cacheKey = entries.map((e) => `${e.module}@${e.digest}`).join("|");
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;
  const model = buildDatasetModel(await readModuleManifests(impl, rest, entries));
  if (modelCache.size >= MODEL_CACHE_SIZE) modelCache.delete(modelCache.keys().next().value as string);
  modelCache.set(cacheKey, model);
  return model;
}

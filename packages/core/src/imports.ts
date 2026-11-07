import { canonicalJson, buildDatasetModel, readModuleEntries, readModuleManifests, writeModules } from "./datasetModules.js";
import type { DatasetModule } from "./datasetModules.js";
import { modelError } from "./errors.js";
import type { ModuleManifest } from "./mclCore.js";
import { importNamespaceOf, loadResolvers } from "./resolvers.js";
import type { Resolvers } from "./resolvers.js";
import { isEmbedded, keyPropertyName } from "./schema.js";
import { NO_ROLES, derivePropertyRoles, resolveType } from "./schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/**
 * Import for data only (see `docs/datasets.md`, Imports, and the import API of
 * `docs/spec/typescript-reference-implementation.md`): an import copies the
 * instances of another dataset under a namespace that prefixes their keys, and
 * the imported dataset brings its modules. The functions here work on resolved
 * formats; `api.ts` resolves the locators, takes the lock and notifies
 * observers.
 */

/** The schema whose instances record the imports of a dataset. */
export const IMPORT_STORE = "import";

/** An instance of `import`. */
export interface ImportRecord extends TransientObject {
  name: string;
  locator: string;
  namespace: string;
  data_major_version: number;
  data_minor_version: number;
  caching_policy: "full" | "partial" | "none";
}

/** One dataset of an import: its format, its rest and its locator. */
export interface DatasetRef {
  impl: PersistenceInterface;
  rest: string;
  locator: string;
}

/** What `checkImport` reports; see `typescript-reference-implementation.md`, API Import. */
export interface CheckImportResult {
  canImport: boolean;
  backImport: TransientValue;
  existingImport: TransientValue;
  additionalImports: { imported: TransientValue; existing: TransientValue }[];
}

/** What `refreshImport` returns: shallow copies of the instances it changed. */
export interface RefreshResult {
  added: TransientValue[];
  removed: TransientValue[];
  before: TransientValue[];
  after: TransientValue[];
  "updated-before": TransientValue[];
  "updated-after": TransientValue[];
}

const POLICY_STRENGTH = { none: 0, partial: 1, full: 2 } as const;

/** The imports of the dataset at `rest`. The bookkeeping entry of a built-in (namespace `""`) is never stored, so never listed. */
export async function listImports(impl: PersistenceInterface, rest: string): Promise<ImportRecord[]> {
  return (await impl.listInstances(rest, IMPORT_STORE, NO_ROLES)) as unknown as ImportRecord[];
}

async function dataVersions(ref: DatasetRef): Promise<{ data_major_version: number; data_minor_version: number }> {
  const info = (await ref.impl.getDataset(ref.rest)) as TransientObject;
  const n = (v: TransientValue | undefined) => (typeof v === "number" ? v : 0);
  return { data_major_version: n(info.data_major_version), data_minor_version: n(info.data_minor_version) };
}

const sameVersions = (a: ImportRecord, b: { data_major_version: number; data_minor_version: number }) =>
  a.data_major_version === b.data_major_version && a.data_minor_version === b.data_minor_version;

/**
 * The modules the importing dataset gains from the imported one, or the reason
 * they cannot join: a second version of a module the importer already uses, or
 * a set that does not build, such as two modules with one namespace.
 */
async function modulesToJoin(
  importer: DatasetRef,
  imported: DatasetRef,
): Promise<{ joined: ModuleManifest[]; added: ModuleManifest[]; conflicts: string[] }> {
  const own = await readModuleEntries(importer.impl, importer.rest);
  const ownManifests = await readModuleManifests(importer.impl, importer.rest, own);
  const theirs = await readModuleEntries(imported.impl, imported.rest);
  const theirManifests = await readModuleManifests(imported.impl, imported.rest, theirs);
  const ownByKey = new Map(own.map((e) => [e.module, e] as const));
  const conflicts: string[] = [];
  const added: ModuleManifest[] = [];
  theirs.forEach((entry: DatasetModule, i) => {
    const mine = ownByKey.get(entry.module);
    if (!mine) added.push(theirManifests[i]);
    else if (mine.version !== entry.version) {
      conflicts.push(`module "${entry.module}" is used at version ${mine.version} by "${importer.locator}" and at ${entry.version} by "${imported.locator}"`);
    }
  });
  const joined = [...ownManifests, ...added];
  if (conflicts.length === 0 && added.length > 0) {
    try {
      buildDatasetModel(joined);
    } catch (err) {
      conflicts.push(`the modules of "${imported.locator}" cannot join those of "${importer.locator}": ${(err as Error).message}`);
    }
  }
  return { joined, added, conflicts };
}

/** `checkImport`, with the reasons that make `canImport` false. */
export async function planImport(importer: DatasetRef, imported: DatasetRef): Promise<{ result: CheckImportResult; reasons: string[] }> {
  if (importer.locator === imported.locator) {
    return {
      result: { canImport: false, backImport: null, existingImport: null, additionalImports: [] },
      reasons: [`"${importer.locator}" cannot import itself`],
    };
  }
  const reasons: string[] = [];
  const ours = await listImports(importer.impl, importer.rest);
  const theirs = await listImports(imported.impl, imported.rest);

  const backImport = theirs.find((i) => i.locator === importer.locator) ?? null;
  if (backImport) reasons.push(`"${imported.locator}" already imports "${importer.locator}": imports go one way`);

  const existingImport = ours.find((i) => i.locator === imported.locator) ?? null;
  if (existingImport && !sameVersions(existingImport, await dataVersions(imported))) {
    reasons.push(`"${imported.locator}" is already imported at other data versions: refresh the import "${existingImport.name}" first`);
  }

  const additionalImports = theirs.map((nested) => {
    const existing = ours.find((i) => i.locator === nested.locator) ?? null;
    if (existing && !sameVersions(existing, nested)) {
      reasons.push(`"${nested.locator}" is imported by both datasets at other data versions: refresh the import "${existing.name}" first`);
    }
    return { imported: nested as TransientValue, existing: existing as TransientValue };
  });

  reasons.push(...(await modulesToJoin(importer, imported)).conflicts);
  return {
    result: { canImport: reasons.length === 0, backImport, existingImport, additionalImports },
    reasons,
  };
}

/** A name and a namespace no import of `taken` uses, starting from `wanted`. */
function allocate(wanted: string, taken: ImportRecord[]): { name: string; namespace: string } {
  const base = wanted.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=[0-9])/, "_") || "import";
  const names = new Set(taken.map((i) => i.name));
  const namespaces = new Set(taken.map((i) => i.namespace));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    if (!names.has(name) && !namespaces.has(`${name}.`)) return { name, namespace: `${name}.` };
  }
}

/** The keyed schemas a dataset stores instances of: every schema but the embedded ones and `import`. */
function keyedSchemas(resolvers: Resolvers): NormalizedSchema[] {
  return [...resolvers.schemas.values()].filter((s) => keyPropertyName(s) !== null && s.name !== IMPORT_STORE && s.name !== "dataset");
}

/**
 * A copy of `instance` of `schema` with its key and every key it holds in a
 * relation rewritten by `rewrite`, embedded instances included. Generated
 * (virtual) relations are never stored, so there is none to rewrite.
 */
function rewriteKeys(schema: NormalizedSchema, instance: TransientObject, resolvers: Resolvers, rewrite: (key: Key) => Key): TransientObject {
  const copy: TransientObject = { ...instance };
  const keyProp = keyPropertyName(schema);
  if (keyProp && typeof copy[keyProp] === "string") copy[keyProp] = rewrite(copy[keyProp] as string);
  for (const prop of schema.properties) {
    if (prop.constraints.__generated === true || prop.name === keyProp) continue;
    const value = copy[prop.name];
    if (value === undefined || value === null) continue;
    let resolved;
    try {
      resolved = resolveType(prop.type, resolvers.ctx);
    } catch {
      continue;
    }
    if (resolved.kind !== "relation") continue;
    const target = resolved.schema;
    const one = (v: TransientValue): TransientValue => {
      if (isEmbedded(target)) return v !== null && typeof v === "object" && !Array.isArray(v) ? rewriteKeys(target, v, resolvers, rewrite) : v;
      return typeof v === "string" ? rewrite(v) : v;
    };
    copy[prop.name] = Array.isArray(value) ? value.map(one) : one(value);
  }
  return copy;
}

/** Every instance of the imported dataset to copy, by schema and new key, with its keys rewritten. */
interface Copy {
  schema: NormalizedSchema;
  key: Key;
  instance: TransientObject;
}

/**
 * Lays out the imports the importer gains by flattening (the nested imports of
 * the imported dataset it does not have yet), the mapping of every namespace
 * of the imported dataset to one of the importer, and the copies of the
 * instances: those of the imported dataset itself under `namespace`, and those
 * of each nested import it gains.
 */
async function layOutCopies(
  importer: DatasetRef,
  imported: DatasetRef,
  namespace: string,
  taken: ImportRecord[],
): Promise<{ newImports: ImportRecord[]; aligned: ImportRecord[]; copies: Map<string, Copy[]> }> {
  const theirs = await listImports(imported.impl, imported.rest);
  const mapping = new Map<string, string>();
  const copied = new Set<string>();
  const newImports: ImportRecord[] = [];
  const aligned: ImportRecord[] = [];
  const all = [...taken];
  for (const nested of theirs) {
    const existing = taken.find((i) => i.locator === nested.locator);
    if (existing) {
      mapping.set(nested.namespace, existing.namespace);
      // the caching policy is aligned to the weakest one
      if (POLICY_STRENGTH[nested.caching_policy] < POLICY_STRENGTH[existing.caching_policy]) {
        aligned.push({ ...existing, caching_policy: nested.caching_policy });
      }
      continue;
    }
    const { name, namespace: ns } = all.some((i) => i.namespace === nested.namespace || i.name === nested.name)
      ? allocate(nested.name, all)
      : { name: nested.name, namespace: nested.namespace };
    const record: ImportRecord = { ...nested, name, namespace: ns };
    newImports.push(record);
    all.push(record);
    mapping.set(nested.namespace, ns);
    copied.add(nested.namespace);
  }

  const sourceResolvers = await loadResolvers(imported.impl, imported.rest);
  const nestedNamespaces = theirs.map((i) => i.namespace);
  const rewrite = (key: Key): Key => {
    const ns = importNamespaceOf(key, nestedNamespaces);
    return ns === undefined ? `${namespace}${key}` : `${mapping.get(ns) ?? ns}${key.slice(ns.length)}`;
  };

  // `namespace` (the import itself) and each namespace copied: the copies to store
  const copies = new Map<string, Copy[]>([[namespace, []]]);
  for (const ns of copied) copies.set(mapping.get(ns) as string, []);
  const moduleSchemas = await moduleSchemaNames(imported);
  for (const schema of keyedSchemas(sourceResolvers)) {
    if (!moduleSchemas.has(schema.name)) continue;
    const keyProp = keyPropertyName(schema) as string;
    for (const raw of await imported.impl.listInstances(imported.rest, schema.name, derivePropertyRoles(schema))) {
      const key = (raw as TransientObject)[keyProp] as string;
      const ns = importNamespaceOf(key, nestedNamespaces);
      if (ns !== undefined && !copied.has(ns)) continue; // the importer has that import already
      const instance = rewriteKeys(schema, raw as TransientObject, sourceResolvers, rewrite);
      const target = ns === undefined ? namespace : (mapping.get(ns) as string);
      copies.get(target)?.push({ schema, key: instance[keyProp] as string, instance });
    }
  }
  return { newImports, aligned, copies };
}

/** The keys of the schemas the modules of a dataset hold: an import copies the instances of these only. */
async function moduleSchemaNames(ref: DatasetRef): Promise<Set<string>> {
  const manifests = await readModuleManifests(ref.impl, ref.rest);
  return new Set(buildDatasetModel(manifests).schemas.keys());
}

/**
 * Clears, in the dataset's own instances, every relation that holds one of
 * `removed`, and records the instances so changed. An instance of an import is
 * not touched: an import never holds a key of the dataset that imports it.
 */
async function clearReferences(
  ref: DatasetRef,
  resolvers: Resolvers,
  removed: Set<Key>,
  acc: { updatedBefore: TransientValue[]; updatedAfter: TransientValue[] },
): Promise<void> {
  if (removed.size === 0) return;
  for (const schema of keyedSchemas(resolvers)) {
    const keyProp = keyPropertyName(schema) as string;
    const roles = derivePropertyRoles(schema);
    for (const raw of await ref.impl.listInstances(ref.rest, schema.name, roles)) {
      const instance = raw as TransientObject;
      if (importNamespaceOf(instance[keyProp] as string, (resolvers.importNamespaces ?? [])) !== undefined) continue;
      let changed = false;
      const after: TransientObject = { ...instance };
      for (const prop of schema.properties) {
        if (prop.constraints.__generated === true) continue;
        const value = instance[prop.name];
        if (typeof value === "string" && removed.has(value)) {
          after[prop.name] = null;
          changed = true;
        } else if (Array.isArray(value) && value.some((v) => typeof v === "string" && removed.has(v))) {
          after[prop.name] = value.filter((v) => !(typeof v === "string" && removed.has(v)));
          changed = true;
        }
      }
      if (!changed) continue;
      await ref.impl.putInstance(ref.rest, schema.name, instance[keyProp] as string, after, roles);
      acc.updatedBefore.push(instance);
      acc.updatedAfter.push(after);
    }
  }
}

/** The instances of the dataset in import namespace `namespace`, by schema and key. */
async function instancesIn(ref: DatasetRef, resolvers: Resolvers, namespace: string): Promise<Map<string, Copy>> {
  const found = new Map<string, Copy>();
  for (const schema of keyedSchemas(resolvers)) {
    const keyProp = keyPropertyName(schema) as string;
    for (const raw of await ref.impl.listInstances(ref.rest, schema.name, derivePropertyRoles(schema))) {
      const key = (raw as TransientObject)[keyProp] as string;
      if (importNamespaceOf(key, (resolvers.importNamespaces ?? [])) === namespace) {
        found.set(`${schema.name}\u0000${key}`, { schema, key, instance: raw as TransientObject });
      }
    }
  }
  return found;
}

async function storeCopies(ref: DatasetRef, copies: Copy[]): Promise<void> {
  for (const copy of copies) await ref.impl.putInstance(ref.rest, copy.schema.name, copy.key, copy.instance, derivePropertyRoles(copy.schema));
}

/**
 * Creates the import of `imported` into `importer`, after `planImport` found
 * it possible: its modules join, its nested imports are flattened, and its
 * instances are copied. Returns the existing import when `imported` is already
 * imported at the same data versions, with `changed` false then.
 */
export async function performImport(importer: DatasetRef, imported: DatasetRef): Promise<{ record: ImportRecord; changed: boolean }> {
  const { result, reasons } = await planImport(importer, imported);
  if (!result.canImport) throw modelError("cannot_import", `cannot import "${imported.locator}" into "${importer.locator}": ${reasons.join("; ")}`);
  if (result.existingImport) return { record: result.existingImport as ImportRecord, changed: false };

  const { joined, added } = await modulesToJoin(importer, imported);
  const taken = await listImports(importer.impl, importer.rest);
  const info = (await imported.impl.getDataset(imported.rest)) as TransientObject;
  const { name, namespace } = allocate(typeof info.name === "string" ? info.name : "import", taken);
  const layout = await layOutCopies(importer, imported, namespace, taken);

  if (added.length > 0) await writeModules(importer.impl, importer.rest, joined);
  for (const copies of layout.copies.values()) await storeCopies(importer, copies);
  const record: ImportRecord = {
    name,
    locator: imported.locator,
    namespace,
    ...(await dataVersions(imported)),
    caching_policy: "full",
  };
  for (const r of [...layout.newImports, ...layout.aligned, record]) {
    await importer.impl.putInstance(importer.rest, IMPORT_STORE, r.name, r, NO_ROLES);
  }
  return { record, changed: true };
}

/** The import `key` of the dataset, or `key_not_found`. */
export async function requireImport(ref: DatasetRef, key: Key): Promise<ImportRecord> {
  const record = await ref.impl.getInstance(ref.rest, IMPORT_STORE, key, NO_ROLES);
  if (record === null) throw modelError("key_not_found", `"${ref.locator}" has no import "${key}"`);
  return record as ImportRecord;
}

/** Removes import `key`: its instances, the relations of the dataset's own instances to them, and the import itself. */
export async function performRemoveImport(ref: DatasetRef, key: Key): Promise<ImportRecord> {
  const record = await requireImport(ref, key);
  const resolvers = await loadResolvers(ref.impl, ref.rest);
  const current = await instancesIn(ref, resolvers, record.namespace);
  for (const { schema, key: k } of current.values()) await ref.impl.deleteInstance(ref.rest, schema.name, k);
  await clearReferences(ref, resolvers, new Set([...current.values()].map((c) => c.key)), { updatedBefore: [], updatedAfter: [] });
  await ref.impl.deleteInstance(ref.rest, IMPORT_STORE, record.name);
  return record;
}

/**
 * Refreshes import `key` from its dataset: the instances added there are
 * copied, those changed are overwritten and those removed are deleted, with the
 * relations of the dataset's own instances to them cleared. Throws
 * `import_not_upgraded` when the imported dataset uses another version of a
 * module the dataset uses; a module the dataset does not use yet joins it.
 */
export async function performRefreshImport(ref: DatasetRef, imported: (locator: string) => DatasetRef, key: Key): Promise<{ result: RefreshResult; changed: boolean }> {
  const record = await requireImport(ref, key);
  const source = imported(record.locator);
  if (!(await source.impl.datasetExists(source.rest))) throw modelError("dataset_not_found", `no dataset at "${record.locator}"`);

  const { joined, added, conflicts } = await modulesToJoin(ref, source);
  if (conflicts.length > 0) {
    throw modelError("import_not_upgraded", `refreshing "${record.name}" of "${ref.locator}": ${conflicts.join("; ")}`);
  }
  if (added.length > 0) await writeModules(ref.impl, ref.rest, joined);

  const taken = (await listImports(ref.impl, ref.rest)).filter((i) => i.name !== record.name);
  const layout = await layOutCopies(ref, source, record.namespace, [...taken, record]);
  for (const r of [...layout.newImports, ...layout.aligned]) await ref.impl.putInstance(ref.rest, IMPORT_STORE, r.name, r, NO_ROLES);
  for (const [ns, copies] of layout.copies) if (ns !== record.namespace) await storeCopies(ref, copies);

  const resolvers = await loadResolvers(ref.impl, ref.rest);
  const current = await instancesIn(ref, resolvers, record.namespace);
  const result: RefreshResult = { added: [], removed: [], before: [], after: [], "updated-before": [], "updated-after": [] };
  for (const copy of layout.copies.get(record.namespace) ?? []) {
    const id = `${copy.schema.name}\u0000${copy.key}`;
    const old = current.get(id);
    current.delete(id);
    if (old && canonicalJson(old.instance) === canonicalJson(copy.instance)) continue;
    await storeCopies(ref, [copy]);
    if (old) {
      result.before.push(old.instance);
      result.after.push(copy.instance);
    } else {
      result.added.push(copy.instance);
    }
  }
  for (const gone of current.values()) {
    await ref.impl.deleteInstance(ref.rest, gone.schema.name, gone.key);
    result.removed.push(gone.instance);
  }
  const acc = { updatedBefore: result["updated-before"], updatedAfter: result["updated-after"] };
  await clearReferences(ref, resolvers, new Set([...current.values()].map((c) => c.key)), acc);

  const versions = await dataVersions(source);
  await ref.impl.putInstance(ref.rest, IMPORT_STORE, record.name, { ...record, ...versions }, NO_ROLES);
  const changed =
    added.length > 0 ||
    layout.newImports.length > 0 ||
    result.added.length + result.removed.length + result.after.length + result["updated-after"].length > 0;
  return { result, changed };
}

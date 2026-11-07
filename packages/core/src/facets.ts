import { modelError } from "./errors.js";
import { parseMapType } from "./mapTypes.js";
import { substitutePlaceholders } from "./placeholders.js";
import { findProperty, keyPropertyName } from "./schema.js";
import { derivePropertyRoles, resolveType } from "./schemaProcessing.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import type { Key, NormalizedProperty, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/**
 * Facets, per packages/core/docs/spec/meta-model.md#facet and the *Facets* parts
 * of `model-command-language.md` (Command, Filter, Schema Processing).
 *
 * A schema F with the constraint `facet_of: T` adds its properties to T and to
 * every schema extending T, under the namespace of the module of F. The module
 * schemas are never changed: the dataset model (`buildDatasetModel` in
 * `datasetModules.ts`) adds to each target, for the modules the dataset uses,
 * one property per property of F, named `namespace.property` and tagged by the
 * internal constraint `__facet` with the key of F. Their values are stored in
 * the instance of F that has the key of the instance of T, and only the values
 * that are set: an unset value has no entry.
 *
 * Inside the engine, an instance holds the values of its facets under their
 * qualified names (`"carbon.co2": 12`), so a facet property is read, filtered
 * and validated like a property of the target. A command takes and returns
 * them as a nested mapping (`carbon: {co2: 12}`): `flattenQualified` and
 * `nestQualified` convert at that boundary.
 */

/** The internal constraint naming, on a property of a target, the facet that adds it. */
export const FACET_TAG = "__facet";

/** The key of the facet that adds `prop` to its schema, or `undefined` for a property of the schema itself. */
export function facetOfProperty(prop: NormalizedProperty): string | undefined {
  const tag = prop.constraints[FACET_TAG];
  return typeof tag === "string" ? tag : undefined;
}

/** The target `schema` is a facet of, or `undefined` when it is not a facet. */
export function facetTargetOf(schema: NormalizedSchema): string | undefined {
  const target = schema.constraints.facet_of;
  return typeof target === "string" ? target : undefined;
}

/** Whether `schema` is a facet: it carries `facet_of`. */
export function isFacet(schema: NormalizedSchema): boolean {
  return facetTargetOf(schema) !== undefined;
}

/** The namespace a qualified name starts with (`carbon` for `carbon.co2`), or `undefined` for a short name. */
export function namespaceOfName(name: string): string | undefined {
  const dot = name.indexOf(".");
  return dot < 0 ? undefined : name.slice(0, dot);
}

/** Whether `prop` is qualified by a namespace: a property of a facet, or a virtual relation from another module. */
export function isQualifiedProperty(prop: NormalizedProperty): boolean {
  return prop.name.includes(".");
}

/** The namespaces under which `schema` carries qualified properties, in the order of its properties. */
export function qualifiedNamespacesOf(schema: NormalizedSchema): string[] {
  const found: string[] = [];
  for (const prop of schema.properties) {
    const ns = namespaceOfName(prop.name);
    if (ns !== undefined && !found.includes(ns)) found.push(ns);
  }
  return found;
}

/** The keys of the facets whose properties `schema` carries, in the order of its properties. */
export function facetNamesOf(schema: NormalizedSchema): string[] {
  const names: string[] = [];
  for (const prop of schema.properties) {
    const facet = facetOfProperty(prop);
    if (facet !== undefined && !names.includes(facet)) names.push(facet);
  }
  return names;
}

/**
 * The name of the virtual relation generated on the target of `prop`, a
 * relation with an `inverse_name` declared on the schema `declaringName`: its
 * `inverse_name`, qualified by the namespace of the declaring schema when the
 * target belongs to another module (see Schema Processing, *Virtual relations
 * across modules*).
 */
export function generatedInverseName(declaringName: string, prop: NormalizedProperty): string {
  const inverse = prop.constraints.inverse_name as string;
  const declaringNs = namespaceOfName(declaringName);
  return declaringNs !== undefined && declaringNs !== namespaceOfName(prop.type) ? `${declaringNs}.${inverse}` : inverse;
}

/**
 * The property a path reaches from segment `i` on `schema`: the property named
 * by the segment, or, when there is none, the qualified property named by the
 * segment and the next one (`carbon.co2`). `consumed` is the number of
 * segments it takes.
 */
export function resolvePathSegment(schema: NormalizedSchema, path: readonly string[], i: number): { prop: NormalizedProperty | undefined; name: string; consumed: number } {
  const own = findProperty(schema, path[i]);
  if (own || i + 1 >= path.length) return { prop: own, name: path[i], consumed: 1 };
  const name = `${path[i]}.${path[i + 1]}`;
  const qualified = findProperty(schema, name);
  return qualified ? { prop: qualified, name, consumed: 2 } : { prop: undefined, name: path[i], consumed: 1 };
}

// ---------------------------------------------------------------------------
// Schema processing
// ---------------------------------------------------------------------------

/** Schema constraints a facet never carries: it has no key of its own and lives beside its target. */
const FORBIDDEN_ON_FACET = ["shared_by_name", "embedded", "is_root"];

/**
 * Checks the rules a facet follows on its own description and its target,
 * each breach a `constraint_violation` (Schema Processing, *Facets*): no `name`
 * property, no `shared_by_name`, `embedded` or `is_root`, no `extends`; no
 * property that is a `mandatory` relation or carries `inverse_name`, `owns` or
 * `owner`; a target that resolves (`unknown_extends_target` otherwise), and is
 * neither a facet nor `embedded`. A schema without `facet_of` is not checked,
 * except that it cannot extend a facet. The rules that need every schema of
 * the dataset are checked by `assembleFacets`.
 */
export function validateFacetSchema(
  schemaName: string,
  properties: NormalizedProperty[],
  constraints: Record<string, TransientValue>,
  parent: NormalizedSchema | undefined,
  ctx: TypeResolutionContext,
): void {
  const fail = (message: string): never => {
    throw modelError("constraint_violation", `facet "${schemaName}" ${message}`);
  };
  if (parent && isFacet(parent)) {
    throw modelError("constraint_violation", `schema "${schemaName}" extends "${parent.name}", a facet — a facet takes no part in extends`);
  }
  const facetOf = constraints.facet_of;
  if (facetOf === undefined) return;
  if (typeof facetOf !== "string" || facetOf === "") fail(`must name its target schema in "facet_of"`);
  if (parent) fail(`extends "${parent.name}" — a facet takes no part in extends`);
  for (const constraint of FORBIDDEN_ON_FACET) {
    if (constraints[constraint] === true) fail(`cannot be "${constraint}" — its instances have the key of the instance of its target`);
  }
  for (const prop of properties) {
    if (prop.name === "name") fail(`has a "name" property — its instances have no key of their own`);
    if (prop.constraints.owner === true || prop.constraints.owns === true || typeof prop.constraints.inverse_name === "string") {
      fail(`has "${prop.name}" with "owner", "owns" or "inverse_name"`);
    }
    if (prop.constraints.mandatory === true && isRelationProperty(prop, ctx)) fail(`has "${prop.name}", a mandatory relation — a value of a facet is optional`);
  }
  const target = ctx.resolveSchema(facetOf as string);
  if (!target) throw modelError("unknown_extends_target", `facet "${schemaName}" is a facet of unknown schema "${facetOf}"`);
  if (isFacet(target)) fail(`is a facet of "${target.name}", which is itself a facet`);
  if (target.constraints.embedded === true) fail(`is a facet of "${target.name}", which is embedded and has no key to share`);
}

function isRelationProperty(prop: NormalizedProperty, ctx: TypeResolutionContext): boolean {
  if (parseMapType(prop.type) !== null) return false;
  try {
    return resolveType(prop.type, ctx).kind === "relation";
  } catch {
    return false;
  }
}

/** `name` and every schema of `schemas` extending it, transitively. */
function withExtenders(schemas: Map<string, NormalizedSchema>, name: string): string[] {
  const found = [name];
  for (let i = 0; i < found.length; i++) {
    for (const s of schemas.values()) if (s.extends === found[i] && !found.includes(s.name)) found.push(s.name);
  }
  return found;
}

/**
 * Adds to the schemas of a dataset the properties of its facets: on the
 * target of each facet and on every schema extending it, each property of the
 * facet under the name `namespace.property`, tagged with `__facet`. Runs after
 * the virtual relations are generated, since their names share the namespace.
 *
 * Throws `constraint_violation` when a relation of any schema targets a facet,
 * when two properties of one module on one target share a name, and when a
 * property of a schema is named like a namespace under which it carries
 * qualified properties.
 */
export function assembleFacets(schemas: Map<string, NormalizedSchema>): void {
  for (const schema of schemas.values()) {
    for (const prop of schema.properties) {
      const target = schemas.get(prop.type);
      if (target && isFacet(target)) {
        throw modelError("constraint_violation", `"${schema.name}.${prop.name}" targets "${target.name}", a facet — a facet is reached only through its target`);
      }
    }
  }
  for (const facet of [...schemas.values()]) {
    const targetName = facetTargetOf(facet);
    if (targetName === undefined) continue;
    const namespace = namespaceOfName(facet.name);
    if (namespace === undefined) throw modelError("constraint_violation", `facet "${facet.name}" belongs to no module`);
    const added = facet.properties.map(
      (p): NormalizedProperty => ({ ...p, name: `${namespace}.${p.name}`, constraints: { ...p.constraints, [FACET_TAG]: facet.name } }),
    );
    for (const holderName of withExtenders(schemas, targetName)) {
      const holder = schemas.get(holderName) as NormalizedSchema;
      for (const prop of added) {
        if (findProperty(holder, prop.name)) {
          throw modelError("constraint_violation", `"${prop.name}" of facet "${facet.name}" is already a property of "${holder.name}"`);
        }
      }
      schemas.set(holderName, { ...holder, properties: [...holder.properties, ...added] });
    }
  }
  for (const schema of schemas.values()) {
    for (const ns of qualifiedNamespacesOf(schema)) {
      if (findProperty(schema, ns)) {
        throw modelError("constraint_violation", `"${schema.name}" has a property "${ns}", named like the namespace of its facets`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Command boundary
// ---------------------------------------------------------------------------

function isMapping(value: unknown): value is TransientObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The input entry `item` of a command on `schema` with its namespaces
 * flattened: `carbon: {co2: 12}` becomes `"carbon.co2": 12`. A key that is no
 * namespace of `schema` is kept as it is. A namespace whose value is not a
 * mapping throws `constraint_violation`, a name in it that is no property of
 * `schema` throws `unknown_property`.
 */
export function flattenQualified(schema: NormalizedSchema, item: TransientObject): TransientObject {
  const namespaces = qualifiedNamespacesOf(schema);
  if (namespaces.length === 0) return item;
  const flat: TransientObject = {};
  for (const [key, value] of Object.entries(item)) {
    if (!namespaces.includes(key)) {
      flat[key] = value;
      continue;
    }
    if (!isMapping(value)) {
      throw modelError("constraint_violation", `"${key}" on "${schema.name}" is a namespace and takes a mapping of its properties`);
    }
    for (const [name, inner] of Object.entries(value)) {
      const qualified = `${key}.${name}`;
      if (!findProperty(schema, qualified)) throw modelError("unknown_property", `"${qualified}" is not a property of "${schema.name}"`);
      flat[qualified] = inner;
    }
  }
  return flat;
}

/**
 * `value` with its qualified keys nested by namespace, as a command returns
 * it: `"carbon.co2": 12` becomes `carbon: {co2: 12}`. Only the keys of the
 * mapping itself are qualified; any other value is returned as it is.
 */
export function nestQualified(value: TransientValue): TransientValue {
  if (!isMapping(value) || !Object.keys(value).some((k) => k.includes("."))) return value;
  const nested: TransientObject = {};
  for (const [key, inner] of Object.entries(value)) {
    const ns = namespaceOfName(key);
    if (ns === undefined) {
      nested[key] = inner;
      continue;
    }
    const group = isMapping(nested[ns]) ? (nested[ns] as TransientObject) : (nested[ns] = {});
    group[key.slice(ns.length + 1)] = inner;
  }
  return nested;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

function copy(value: TransientValue): TransientValue {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The value `prop`, a facet property with no stored value, reads as: its
 * `default_value`, resolved against `instance` and coerced to its type, or
 * `undefined` when it has none.
 */
function defaultOf(prop: NormalizedProperty, ctx: TypeResolutionContext, instance: TransientObject): TransientValue | undefined {
  if (prop.default_value === null) return undefined;
  let resolved;
  try {
    resolved = resolveType(prop.type, ctx);
  } catch {
    return undefined;
  }
  if (resolved.kind !== "scalar") return undefined;
  const raw = substitutePlaceholders(prop.default_value, { this: instance });
  if (raw === null) return undefined;
  if (prop.constraints.is_array === true) return undefined;
  switch (resolved.base) {
    case "number":
      return Number(raw);
    case "integer":
      return Math.trunc(Number(raw));
    case "boolean":
      return raw === true || raw === "true";
    default:
      return typeof raw === "string" ? raw : String(raw);
  }
}

/**
 * Reads into `instance`, an instance of `schema` with key `key`, the values
 * its facets hold for it, under their qualified names. A value with no entry
 * reads as its `default_value`, and is left out when it has none. Returns
 * `instance`.
 */
export async function mergeFacetValues(
  impl: PersistenceInterface,
  rest: string,
  ctx: TypeResolutionContext,
  schema: NormalizedSchema,
  key: Key,
  instance: TransientObject,
): Promise<TransientObject> {
  for (const facetName of facetNamesOf(schema)) {
    const facet = ctx.resolveSchema(facetName);
    const stored = facet ? await impl.getInstance(rest, facetName, key, derivePropertyRoles(facet)) : null;
    const values = isMapping(stored) ? stored : {};
    for (const prop of schema.properties) {
      if (facetOfProperty(prop) !== facetName) continue;
      const short = prop.name.slice(prop.name.indexOf(".") + 1);
      const value = values[short];
      if (value !== undefined && value !== null) instance[prop.name] = copy(value);
      else {
        delete instance[prop.name];
        const fallback = defaultOf(prop, ctx, instance);
        if (fallback !== undefined) instance[prop.name] = fallback;
      }
    }
  }
  return instance;
}

/**
 * Applies `changes`, values by qualified name, to the facet instances of the
 * instance with key `key` of `schema`: a value is set, `null` or `undefined`
 * unsets it. The instance of a facet is created on its first value, and
 * removed once it holds none. A name that is no facet property is ignored.
 */
export async function writeFacetValues(
  impl: PersistenceInterface,
  rest: string,
  ctx: TypeResolutionContext,
  schema: NormalizedSchema,
  key: Key,
  changes: TransientObject,
): Promise<void> {
  const byFacet = new Map<string, [string, TransientValue][]>();
  for (const [name, value] of Object.entries(changes)) {
    const prop = findProperty(schema, name);
    const facetName = prop ? facetOfProperty(prop) : undefined;
    if (!facetName) continue;
    const list = byFacet.get(facetName) ?? [];
    list.push([name.slice(name.indexOf(".") + 1), value]);
    byFacet.set(facetName, list);
  }
  for (const [facetName, entries] of byFacet) {
    const facet = ctx.resolveSchema(facetName);
    if (!facet) continue;
    const roles = derivePropertyRoles(facet);
    const stored = await impl.getInstance(rest, facetName, key, roles);
    const values: TransientObject = isMapping(stored) ? { ...stored } : {};
    const keyProp = keyPropertyName(facet) ?? "id";
    delete values[keyProp];
    for (const [short, value] of entries) {
      if (value === null || value === undefined) delete values[short];
      else values[short] = copy(value);
    }
    for (const [short, value] of Object.entries(values)) if (value === null) delete values[short];
    if (Object.keys(values).length === 0) {
      if (stored !== null) await impl.deleteInstance(rest, facetName, key);
    } else {
      await impl.putInstance(rest, facetName, key, { [keyProp]: key, ...values }, roles);
    }
  }
}

/** Deletes the facet instances of the instance with key `key` of `schema`, whatever their module. */
export async function deleteFacetInstances(
  impl: PersistenceInterface,
  rest: string,
  ctx: TypeResolutionContext,
  schema: NormalizedSchema,
  key: Key,
): Promise<void> {
  for (const facetName of facetNamesOf(schema)) {
    const facet = ctx.resolveSchema(facetName);
    if (!facet) continue;
    if ((await impl.getInstance(rest, facetName, key, derivePropertyRoles(facet))) !== null) await impl.deleteInstance(rest, facetName, key);
  }
}

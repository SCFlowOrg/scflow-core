import { modelError } from "./errors.js";
import { mergeExtensionValues } from "./extensionData.js";
import { extensionNamesOf } from "./extensions.js";
import { findProperty, isEmbedded } from "./schema.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import { derivePropertyRoles, resolveType } from "./schemaProcessing.js";
import type { Filter, Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/**
 * Filter matching, per packages/core/docs/spec/model-command-language.md#filter.
 */

const COMBINATORS = new Set(["and", "or", "not"]);

/**
 * What a path through a map yields when the instance has no entry for the key:
 * no value, which is not the same as a `null` one — an instance without the
 * entry satisfies no predicate on the path, `ne` included.
 */
const NO_ENTRY = Symbol("no map entry");

/** The JSON text of `value` with the entries of every mapping in key order: a map is unordered, so two maps with the same entries are equal. */
function canonicalJson(value: TransientValue): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as TransientObject).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function deepEqual(a: TransientValue, b: TransientValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function comparablePrimitive(value: TransientValue): number | string {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t) && /^\d{4}-\d{2}-\d{2}/.test(value)) return t;
    return value;
  }
  return String(value);
}

/** Equality of two arrays without regard to order, for the value of an `is_set` property, which holds no duplicate; anything else compares as `deepEqual`. */
function setEqual(a: TransientValue, b: TransientValue): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return deepEqual(a, b);
  return a.length === b.length && a.every((x) => b.some((y) => deepEqual(x, y))) && b.every((y) => a.some((x) => deepEqual(x, y)));
}

function applyOperator(op: string, actual: TransientValue, expected: TransientValue, isSet = false): boolean {
  const equal = isSet ? setEqual : deepEqual;
  switch (op) {
    case "eq":
      return equal(actual, expected);
    case "ne":
      return !equal(actual, expected);
    case "lt":
      return comparablePrimitive(actual) < comparablePrimitive(expected);
    case "lte":
      return comparablePrimitive(actual) <= comparablePrimitive(expected);
    case "gt":
      return comparablePrimitive(actual) > comparablePrimitive(expected);
    case "gte":
      return comparablePrimitive(actual) >= comparablePrimitive(expected);
    case "in":
      return Array.isArray(expected) && expected.some((e) => equal(actual, e));
    case "contains":
      if (Array.isArray(actual)) return actual.some((e) => deepEqual(e, expected));
      if (typeof actual === "string") return actual.includes(String(expected));
      return false;
    case "matches":
      return typeof actual === "string" && new RegExp(String(expected)).test(actual);
    case "exists": {
      const isMap = actual !== null && typeof actual === "object" && !Array.isArray(actual);
      const present = actual !== null && (Array.isArray(actual) ? actual.length > 0 : isMap ? Object.keys(actual as TransientObject).length > 0 : true);
      return expected === false ? !present : present;
    }
    default:
      throw modelError("invalid_operator", `unknown filter operator "${op}"`);
  }
}

function matchPredicate(actual: TransientValue, predicateValue: unknown, isSet = false): boolean {
  if (predicateValue !== null && typeof predicateValue === "object" && !Array.isArray(predicateValue)) {
    for (const [op, operand] of Object.entries(predicateValue as TransientObject)) {
      if (!applyOperator(op, actual, operand, isSet)) return false;
    }
    return true;
  }
  return applyOperator("eq", actual, predicateValue as TransientValue, isSet);
}

export interface FilterEvalContext extends TypeResolutionContext {
  impl: PersistenceInterface;
  rest: string;
}

async function getPathValue(
  instance: TransientValue,
  schema: NormalizedSchema,
  path: string[],
  ctx: FilterEvalContext,
): Promise<TransientValue | typeof NO_ENTRY> {
  let current: TransientValue = instance;
  let currentSchema: NormalizedSchema | null = schema;

  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const isLast = i === path.length - 1;
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const obj = current as TransientObject;
    const prop = currentSchema ? findProperty(currentSchema, segment) : undefined;
    if (!prop && segment !== "id" && segment !== "name") {
      throw modelError("unknown_property", `"${segment}" does not resolve on schema "${currentSchema?.name}"`);
    }
    const value = obj[segment] ?? null;
    if (isLast) return value;

    // descending further requires this segment to be a relation
    if (!prop) return null;
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind === "map") {
      // the next segment is the key of an entry: `display_name.fr`; `resolvePathIsArray` has refused a path that goes on
      const entryKey = path[i + 1];
      if (value === null || typeof value !== "object" || Array.isArray(value)) return NO_ENTRY;
      return Object.prototype.hasOwnProperty.call(value, entryKey) ? (value as TransientObject)[entryKey] : NO_ENTRY;
    }
    if (resolved.kind !== "relation") {
      throw modelError("unknown_property", `"${segment}" is not a relation, cannot continue path "${path.join(".")}"`);
    }
    if (Array.isArray(value) || value === null) return null; // multi-valued/absent — not traversable further here
    const target = await ctx.impl.getInstance(ctx.rest, resolved.schema.name, value as Key, derivePropertyRoles(resolved.schema));
    // the target's extension values live in other instances: read in, on a copy, so the path reaches them like its own properties
    const reachesExtensions = target !== null && typeof target === "object" && !Array.isArray(target) && extensionNamesOf(resolved.schema).length > 0;
    current = reachesExtensions ? await mergeExtensionValues(ctx.impl, ctx.rest, ctx, resolved.schema, value as Key, { ...(target as TransientObject) }) : target;
    currentSchema = resolved.schema;
  }
  return current;
}

/**
 * Resolves a property path on the schema alone — no instance is read — the
 * same way `getPathValue` navigates it: a relation segment continues on its
 * target schema, `id` and `name` resolve as single-valued scalars when not
 * declared. Returns whether the property the path ends on is an array;
 * throws `unknown_property` when the path does not resolve.
 */
function resolvePathIsArray(schema: NormalizedSchema, path: string[], ctx: TypeResolutionContext): boolean {
  return resolvePathKind(schema, path, ctx).isArray;
}

/** What `resolvePathIsArray` computes, and whether the property the path ends on is an `is_set` one. */
function resolvePathKind(schema: NormalizedSchema, path: string[], ctx: TypeResolutionContext): { isArray: boolean; isSet: boolean } {
  const singleValued = { isArray: false, isSet: false };
  let currentSchema = schema;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const isLast = i === path.length - 1;
    const prop = findProperty(currentSchema, segment);
    if (!prop) {
      if ((segment === "id" || segment === "name") && isLast) return singleValued;
      throw modelError("unknown_property", `"${segment}" does not resolve on schema "${currentSchema.name}"`);
    }
    if (isLast) return { isArray: prop.constraints.is_array === true, isSet: prop.constraints.is_set === true };
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind === "map") {
      // the one segment after a map property is the key of an entry, a single value; a path that goes on does not resolve
      if (i + 2 !== path.length) {
        throw modelError("unknown_property", `a path through the map "${segment}" ends with the key of an entry, cannot continue path "${path.join(".")}"`);
      }
      return singleValued;
    }
    if (resolved.kind !== "relation") {
      throw modelError("unknown_property", `"${segment}" is not a relation, cannot continue path "${path.join(".")}"`);
    }
    currentSchema = resolved.schema;
  }
  return singleValued;
}

function arrayValueMismatch(path: string, what: string) {
  return modelError(
    "type_mismatch",
    `${what} on "${path}", which is not an array property — to match any of several values, write {"${path}": {"in": [...]}}`,
  );
}

function isMapping(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Checks one level of a filter against the filter spec's *Shape*: the filter
 * is a mapping, `and`/`or` hold arrays, `not` holds a mapping. Nested filters
 * are checked as `checkFilter` recurses into them.
 */
function checkFilterShape(filter: unknown, where: string): void {
  if (!isMapping(filter)) {
    throw modelError(
      "invalid_filter",
      `${where} must be a mapping of property paths, got ${describeShape(filter)} — several conditions are several keys of one mapping, or the elements of {"and": [...]}`,
    );
  }
  const obj = filter as Record<string, unknown>;
  for (const key of ["and", "or"]) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) {
      throw modelError("invalid_filter", `"${key}" must be an array of filters, got ${describeShape(obj[key])}`);
    }
  }
  if (obj.not !== undefined && !isMapping(obj.not)) {
    throw modelError("invalid_filter", `"not" must be a single filter mapping, got ${describeShape(obj.not)}`);
  }
}

/**
 * Checks a filter against a schema before any instance is read. The filter is
 * a mapping, `and` and `or` hold arrays and `not` a mapping (`invalid_filter`).
 * Every property path resolves on the schema alone (`unknown_property`), even
 * when the schema holds no instance: a relation segment continues on the target
 * schema, and `id` and `name` count as single-valued scalars. An array used as a
 * value, bare or as the
 * operand of `eq` or `ne`, on a property that is not an array is refused, and
 * so is an `in` operand that is not an array (`type_mismatch`).
 *
 * A polymorphic command checks each candidate schema (a schema and those
 * extending it) through `checkFilterOnCandidates`: a path that resolves on no
 * candidate is `unknown_property`, and the candidates it does not resolve on
 * keep matching as before.
 */
export function checkFilter(
  filter: Filter | undefined,
  schema: NormalizedSchema,
  ctx: TypeResolutionContext,
  where = "filters",
): void {
  if (filter === undefined || filter === null) return;
  checkFilterShape(filter, where);
  (filter.and ?? []).forEach((f, i) => checkFilter(f, schema, ctx, `"and"[${i}]`));
  (filter.or ?? []).forEach((f, i) => checkFilter(f, schema, ctx, `"or"[${i}]`));
  if (filter.not !== undefined) checkFilter(filter.not, schema, ctx, `"not"`);
  return checkPredicates(filter, schema, ctx);
}

function checkPredicates(filter: Filter, schema: NormalizedSchema, ctx: TypeResolutionContext): void {
  for (const [key, predicateValue] of Object.entries(filter)) {
    if (COMBINATORS.has(key)) continue;
    const isArray = resolvePathIsArray(schema, key.split("."), ctx);
    if (Array.isArray(predicateValue)) {
      if (!isArray) throw arrayValueMismatch(key, "an array is used as a value");
      continue;
    }
    if (predicateValue === null || typeof predicateValue !== "object") continue;
    for (const [op, operand] of Object.entries(predicateValue as TransientObject)) {
      if ((op === "eq" || op === "ne") && Array.isArray(operand) && !isArray) {
        throw arrayValueMismatch(key, `an array is the operand of "${op}"`);
      }
      if (op === "in" && !Array.isArray(operand)) {
        throw modelError("type_mismatch", `the operand of "in" on "${key}" must be an array`);
      }
    }
  }
}

/**
 * `checkFilter` over the candidate schemas of one command (a schema and those
 * extending it): a path that resolves on none of them is `unknown_property`;
 * the candidates it does not resolve on keep matching as before.
 */
export function checkFilterOnCandidates(
  filter: Filter | undefined,
  candidates: NormalizedSchema[],
  ctx: TypeResolutionContext,
): void {
  if (filter === undefined || filter === null) return;
  let firstUnknown: unknown = null;
  let resolvedOnAny = false;
  for (const candidate of candidates) {
    try {
      checkFilter(filter, candidate, ctx);
      resolvedOnAny = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "unknown_property") throw err;
      firstUnknown ??= err;
    }
  }
  if (!resolvedOnAny && firstUnknown) throw firstUnknown;
}

/**
 * Whether `instance` of `schema` satisfies `filter`. An absent or empty filter
 * matches; `and` needs every filter to match (an empty `and` matches), `or` at
 * least one (an empty `or` matches nothing), `not` a filter that does not
 * match; every other key is a predicate on a dot-separated property path,
 * which may cross relations. It does not validate the filter: run `checkFilter`
 * first.
 */
export async function matchFilter(
  instance: TransientValue,
  filter: Filter | undefined,
  schema: NormalizedSchema,
  ctx: FilterEvalContext,
): Promise<boolean> {
  if (!filter || Object.keys(filter).length === 0) return true;

  if (filter.and) {
    for (const f of filter.and) {
      if (!(await matchFilter(instance, f, schema, ctx))) return false;
    }
  }
  if (filter.or) {
    if (filter.or.length === 0) return false;
    let any = false;
    for (const f of filter.or) {
      if (await matchFilter(instance, f, schema, ctx)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  if (filter.not) {
    if (await matchFilter(instance, filter.not, schema, ctx)) return false;
  }

  for (const [key, predicateValue] of Object.entries(filter)) {
    if (COMBINATORS.has(key)) continue;
    const actual = await getPathValue(instance, schema, key.split("."), ctx);
    if (actual === NO_ENTRY) return false;
    const isSet = Array.isArray(actual) && resolvePathKind(schema, key.split("."), ctx).isSet;
    if (!matchPredicate(actual, predicateValue, isSet)) return false;
  }
  return true;
}

/** True for embedded schemas — filters never traverse into embedded arrays as list targets here (out of scope for v1). */
export function assertNotEmbedded(schema: NormalizedSchema) {
  if (isEmbedded(schema)) {
    throw modelError("unknown_schema", `"${schema.name}" is embedded, not a queryable schema`);
  }
}

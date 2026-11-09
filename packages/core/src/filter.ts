import { modelError } from "./errors.js";
import { facetNamesOf, facetOfProperty, mergeFacetValues, resolvePathSegment } from "./facets.js";
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

/**
 * What a path yields when it reaches a property of a facet that has no value:
 * an unset value, which satisfies no predicate except `exists` (see Filter).
 */
const UNSET = Symbol("unset facet value");

/** Whether a predicate holds on an unset value: only `{exists: false}` does. */
function matchesUnset(predicateValue: unknown): boolean {
  if (predicateValue === null || typeof predicateValue !== "object" || Array.isArray(predicateValue)) return false;
  const ops = Object.entries(predicateValue as TransientObject);
  return ops.length > 0 && ops.every(([op, operand]) => op === "exists" && operand === false);
}

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
    case "subset_of":
      // every entry of the value is one of the operand; an empty value is a subset of anything
      return Array.isArray(actual) && Array.isArray(expected) && actual.every((e) => expected.some((x) => deepEqual(e, x)));
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

/** What an operand that names a path on the instance yields when the path reaches no value: it satisfies no predicate. */
const MISSING = Symbol("missing operand");

type Operand = TransientValue | typeof MISSING;

function matchPredicate(
  actual: TransientValue,
  predicateValue: unknown,
  isSet = false,
  resolveOperand: (operand: unknown) => Operand = (o) => o as TransientValue,
): boolean {
  if (predicateValue !== null && typeof predicateValue === "object" && !Array.isArray(predicateValue)) {
    for (const [op, raw] of Object.entries(predicateValue as TransientObject)) {
      const operand = resolveOperand(raw);
      if (operand === MISSING || !applyOperator(op, actual, operand, isSet)) return false;
    }
    return true;
  }
  const operand = resolveOperand(predicateValue);
  return operand !== MISSING && applyOperator("eq", actual, operand, isSet);
}

/** A whole placeholder that is a plain path starting at `this`: what an operand may be besides a literal (see Filter, *Paths on the right*). */
const THIS_PATH = /^\$\{\s*this((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}$/;

/**
 * The path an operand names on the instance being tested, without its leading
 * `this`, or `undefined` for a literal. A string holding any other `${...}`
 * (a function, surrounding text, another root, several placeholders) is
 * refused with `invalid_filter`, so that a filter stays translatable.
 */
export function operandPath(operand: unknown): string[] | undefined {
  if (typeof operand !== "string" || !operand.includes("${")) return undefined;
  const match = THIS_PATH.exec(operand.trim());
  if (!match) {
    throw modelError(
      "invalid_filter",
      `the operand ${JSON.stringify(operand)} is not one whole placeholder naming a plain path that starts at this, such as "\${this.source.type}"`,
    );
  }
  return match[1].slice(1).split(".");
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
): Promise<TransientValue | typeof NO_ENTRY | typeof UNSET> {
  let current: TransientValue = instance;
  let currentSchema: NormalizedSchema | null = schema;

  for (let i = 0; i < path.length; ) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const obj = current as TransientObject;
    // a segment is a property, or a namespace followed by a property of a facet or a virtual relation of another module
    const { prop, name: segment, consumed } = currentSchema ? resolvePathSegment(currentSchema, path, i) : { prop: undefined, name: path[i], consumed: 1 };
    i += consumed;
    const isLast = i >= path.length;
    if (!prop && segment !== "id" && segment !== "name") {
      throw modelError("unknown_property", `"${segment}" does not resolve on schema "${currentSchema?.name}"`);
    }
    if (prop && facetOfProperty(prop) !== undefined && (obj[segment] === undefined || obj[segment] === null)) return UNSET;
    const value = obj[segment] ?? null;
    if (isLast) return value;

    // descending further requires this segment to be a relation
    if (!prop) return null;
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind === "map") {
      // the next segment is the key of an entry: `display_name.fr`; `resolvePathIsArray` has refused a path that goes on
      const entryKey = path[i];
      if (value === null || typeof value !== "object" || Array.isArray(value)) return NO_ENTRY;
      return Object.prototype.hasOwnProperty.call(value, entryKey) ? (value as TransientObject)[entryKey] : NO_ENTRY;
    }
    if (resolved.kind !== "relation") {
      throw modelError("unknown_property", `"${segment}" is not a relation, cannot continue path "${path.join(".")}"`);
    }
    if (Array.isArray(value) || value === null) return null; // multi-valued/absent — not traversable further here
    const target = await ctx.impl.getInstance(ctx.rest, resolved.schema.name, value as Key, derivePropertyRoles(resolved.schema));
    // the target's facet values live in other instances: read in, on a copy, so the path reaches them like its own properties
    const isObject = target !== null && typeof target === "object" && !Array.isArray(target);
    current = target;
    if (isObject && facetNamesOf(resolved.schema).length > 0) {
      current = await mergeFacetValues(ctx.impl, ctx.rest, ctx, resolved.schema, value as Key, { ...(current as TransientObject) });
    }
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
function resolvePathKind(
  schema: NormalizedSchema,
  path: string[],
  ctx: TypeResolutionContext,
  singleRelations = false,
): { isArray: boolean; isSet: boolean } {
  const singleValued = { isArray: false, isSet: false };
  let currentSchema = schema;
  for (let i = 0; i < path.length; ) {
    const { prop, name: segment, consumed } = resolvePathSegment(currentSchema, path, i);
    i += consumed;
    const isLast = i >= path.length;
    if (!prop) {
      if ((segment === "id" || segment === "name") && isLast) return singleValued;
      throw modelError("unknown_property", `"${segment}" does not resolve on schema "${currentSchema.name}"`);
    }
    if (isLast) return { isArray: prop.constraints.is_array === true, isSet: prop.constraints.is_set === true };
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind === "map") {
      // the one segment after a map property is the key of an entry, a single value; a path that goes on does not resolve
      if (i + 1 !== path.length) {
        throw modelError("unknown_property", `a path through the map "${segment}" ends with the key of an entry, cannot continue path "${path.join(".")}"`);
      }
      return singleValued;
    }
    if (resolved.kind !== "relation") {
      throw modelError("unknown_property", `"${segment}" is not a relation, cannot continue path "${path.join(".")}"`);
    }
    if (singleRelations && prop.constraints.is_array === true) {
      throw modelError(
        "constraint_violation",
        `the path "${path.join(".")}" crosses "${segment}", a relation to several instances — a rule crosses single-valued relations only`,
      );
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
  singleRelations = false,
): void {
  if (filter === undefined || filter === null) return;
  checkFilterShape(filter, where);
  (filter.and ?? []).forEach((f, i) => checkFilter(f, schema, ctx, `"and"[${i}]`, singleRelations));
  (filter.or ?? []).forEach((f, i) => checkFilter(f, schema, ctx, `"or"[${i}]`, singleRelations));
  if (filter.not !== undefined) checkFilter(filter.not, schema, ctx, `"not"`, singleRelations);
  return checkPredicates(filter, schema, ctx, singleRelations);
}

/**
 * `checkFilter` for the `when` and `require` of a rule (see `rules.ts`): a
 * path, on the left or on the right, that crosses a relation to several
 * instances is refused with `constraint_violation`.
 */
export function checkRuleFilter(filter: Filter | undefined, schema: NormalizedSchema, ctx: TypeResolutionContext, where: string): void {
  checkFilter(filter, schema, ctx, where, true);
}

/** Resolves a path on the schema alone, as `checkFilter` does a path on the left; `singleRelations` refuses a relation to several instances on the way. */
export function checkPath(schema: NormalizedSchema, path: string[], ctx: TypeResolutionContext, singleRelations = false): void {
  resolvePathKind(schema, path, ctx, singleRelations);
}

function checkPredicates(filter: Filter, schema: NormalizedSchema, ctx: TypeResolutionContext, singleRelations = false): void {
  for (const [key, predicateValue] of Object.entries(filter)) {
    if (COMBINATORS.has(key)) continue;
    const isArray = resolvePathKind(schema, key.split("."), ctx, singleRelations).isArray;
    if (Array.isArray(predicateValue)) {
      if (!isArray) throw arrayValueMismatch(key, "an array is used as a value");
      continue;
    }
    if (predicateValue === null || typeof predicateValue !== "object") {
      const path = operandPath(predicateValue);
      if (path) resolvePathKind(schema, path, ctx, singleRelations);
      continue;
    }
    for (const [op, operand] of Object.entries(predicateValue as TransientObject)) {
      if (op === "subset_of" && !isArray) {
        throw modelError("invalid_operator", `"subset_of" applies to an array property, and "${key}" is not one`);
      }
      const path = operandPath(operand);
      if (path) {
        // a path on the right is resolved per instance, so its value is checked then
        resolvePathKind(schema, path, ctx, singleRelations);
        continue;
      }
      if ((op === "eq" || op === "ne") && Array.isArray(operand) && !isArray) {
        throw arrayValueMismatch(key, `an array is the operand of "${op}"`);
      }
      if ((op === "in" || op === "subset_of") && !Array.isArray(operand)) {
        throw modelError("type_mismatch", `the operand of "${op}" on "${key}" must be an array`);
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
    if (actual === UNSET) {
      if (!matchesUnset(predicateValue)) return false;
      continue;
    }
    const isSet = Array.isArray(actual) && resolvePathKind(schema, key.split("."), ctx).isSet;
    const operands = await resolveOperands(predicateValue, instance, schema, ctx);
    const resolveOperand = (operand: unknown): Operand =>
      typeof operand === "string" && operands.has(operand) ? (operands.get(operand) as Operand) : (operand as TransientValue);
    if (!matchPredicate(actual, predicateValue, isSet, resolveOperand)) return false;
  }
  return true;
}

/** The operands of a predicate that name a path on the instance, resolved on `instance`; a path that reaches no value is `MISSING`. */
async function resolveOperands(
  predicateValue: unknown,
  instance: TransientValue,
  schema: NormalizedSchema,
  ctx: FilterEvalContext,
): Promise<Map<string, Operand>> {
  const resolved = new Map<string, Operand>();
  const operands =
    predicateValue !== null && typeof predicateValue === "object" && !Array.isArray(predicateValue)
      ? Object.values(predicateValue as TransientObject)
      : [predicateValue];
  for (const operand of operands) {
    const path = operandPath(operand);
    if (!path || resolved.has(operand as string)) continue;
    const value = await getPathValue(instance, schema, path, ctx);
    resolved.set(operand as string, value === null || value === NO_ENTRY || value === UNSET ? MISSING : value);
  }
  return resolved;
}

/**
 * The value a path reaches on `instance` of `schema`, crossing relations as a
 * filter does, or `undefined` when it reaches none: a null relation on the way
 * or at its end, a missing entry of a map, an unset value of a facet. A rule
 * reads the operands of `each` and `with` this way (see `rules.ts`).
 */
export async function valueOnPath(
  instance: TransientValue,
  schema: NormalizedSchema,
  path: string[],
  ctx: FilterEvalContext,
): Promise<TransientValue | undefined> {
  const value = await getPathValue(instance, schema, path, ctx);
  return value === null || value === NO_ENTRY || value === UNSET ? undefined : value;
}

/**
 * Whether the plain value `root` satisfies `filter`, for the `when` of a step
 * of a script (see `script.ts`): a path names keys of nested mappings, an index
 * of an array, or, otherwise on an array, its first entry, as a placeholder
 * does. A path that reaches nothing satisfies no predicate except
 * `{exists: false}`. The operators are those of a filter on instances.
 */
export function matchValueFilter(root: TransientObject, filter: unknown): boolean {
  checkFilterShape(filter, "when");
  const f = filter as Filter;
  if (f.and && !f.and.every((sub) => matchValueFilter(root, sub))) return false;
  if (f.or && !f.or.some((sub) => matchValueFilter(root, sub))) return false;
  if (f.not && matchValueFilter(root, f.not)) return false;
  for (const [key, predicateValue] of Object.entries(f)) {
    if (COMBINATORS.has(key)) continue;
    const actual = valueAtPath(root, key.split("."));
    if (actual === NO_ENTRY) {
      if (!matchesUnset(predicateValue)) return false;
      continue;
    }
    if (!matchPredicate(actual, predicateValue)) return false;
  }
  return true;
}

function valueAtPath(root: TransientValue, path: string[]): TransientValue | typeof NO_ENTRY {
  let current: TransientValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (/^\d+$/.test(segment)) {
        current = current[Number(segment)] ?? null;
        continue;
      }
      current = current[0] ?? null;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) return NO_ENTRY;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return NO_ENTRY;
    current = (current as TransientObject)[segment];
  }
  return current === undefined ? NO_ENTRY : current;
}

/** True for embedded schemas — filters never traverse into embedded arrays as list targets here (out of scope for v1). */
export function assertNotEmbedded(schema: NormalizedSchema) {
  if (isEmbedded(schema)) {
    throw modelError("unknown_schema", `"${schema.name}" is embedded, not a queryable schema`);
  }
}

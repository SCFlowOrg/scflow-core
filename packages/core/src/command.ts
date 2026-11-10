import { modelError } from "./errors.js";
import {
  deleteFacetInstances,
  facetOfProperty,
  flattenQualified,
  generatedInverseName,
  isFacet,
  mergeFacetValues,
  nestQualified,
  qualifiedNamespacesOf,
  writeFacetValues,
} from "./facets.js";
import { validateLanguages } from "./languages.js";
import { resolveCreateId } from "./ids.js";
import { checkFilter, checkFilterOnCandidates, matchFilter, valueOnPath } from "./filter.js";
import type { Filter as CommandFilter } from "./types.js";
import { facetNamesOf as facetNamesOfSchema } from "./facets.js";
import { isModelSchema, getUpgradeMarker, runSchemaCommand } from "./modelUpgrade.js";
import { substitutePlaceholders } from "./placeholders.js";
import { isPlainObject, resolveTextOperation } from "./textOperations.js";
import { importNamespaceOf } from "./resolvers.js";
import type { Resolvers } from "./resolvers.js";
import { findProperty, isRoot, isSharedByName, keyPropertyName, ownerProperties } from "./schema.js";
import { derivePropertyRoles, resolveType, scalarDefaultValue, scalarNullValue, NO_ROLES, SCHEMA_ROLES } from "./schemaProcessing.js";
import type { OnDelete, ResolvedType } from "./schemaProcessing.js";
import { COMMAND_KINDS } from "./types.js";
import type {
  Command,
  CommandResult,
  Key,
  NormalizedProperty,
  NormalizedSchema,
  PersistenceInterface,
  ResultOptions,
  TransientObject,
  TransientValue,
} from "./types.js";

/**
 * Command processing, per packages/core/docs/spec/model-command-language.md#command's "Processing" section.
 */

function clone<T extends TransientValue>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function keyOf(schema: NormalizedSchema, instance: TransientValue): Key {
  const obj = instance as TransientObject;
  const propName = keyPropertyName(schema);
  if (!propName) throw modelError("constraint_violation", `"${schema.name}" is embedded, has no key`);
  const value = obj[propName];
  if (typeof value !== "string") {
    throw modelError("constraint_violation", `"${schema.name}" instance is missing its key property "${propName}"`);
  }
  return value;
}

function emptyResult(): CommandResult {
  return { before: [], after: [], "cascade-deleted": [], "updated-before": [], "updated-after": [] };
}

/**
 * Kept by every projected object whatever `result.properties` lists, so a
 * returned object stays addressable. Both names are kept when both are
 * present rather than the one that is actually this schema's key: the
 * buckets hold objects from other schemas too (`cascade-deleted`, and
 * anything an inverse or ownership rule touched), and their key property
 * isn't knowable from the command's own schema.
 */
const KEY_PROPERTIES = ["name", "id"];

function projectObject(value: TransientValue, keep: Set<string>): TransientValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const projected: TransientObject = {};
  for (const [name, propValue] of Object.entries(value as TransientObject)) {
    if (keep.has(name)) projected[name] = propValue;
  }
  return projected;
}

/**
 * Narrows a result per `command.result`, per packages/core/docs/spec/model-command-language.md#command's
 * "Result shaping". Runs on the way out of runCommand, after everything the
 * command does has already happened — shaping never changes which instances
 * are acted on, only how much of them comes back.
 */
function shapeResult(
  result: CommandResult,
  schema: NormalizedSchema,
  options: ResultOptions | undefined,
  kind: Command["kind"],
): CommandResult {
  let shaped = result;
  if (options?.properties !== undefined) {
    const namespaces = qualifiedNamespacesOf(schema);
    for (const name of options.properties) {
      if (!KEY_PROPERTIES.includes(name) && !findProperty(schema, name) && !namespaces.includes(name)) {
        throw modelError("unknown_property", `"${name}" is not a property of "${schema.name}"`);
      }
    }
    // a namespace keeps every property it qualifies
    const keep = new Set<string>([...KEY_PROPERTIES, ...options.properties]);
    for (const prop of schema.properties) {
      const dot = prop.name.indexOf(".");
      if (dot > 0 && keep.has(prop.name.slice(0, dot))) keep.add(prop.name);
    }
    shaped = {
      before: result.before.map((v) => projectObject(v, keep)),
      after: result.after.map((v) => projectObject(v, keep)),
      "cascade-deleted": result["cascade-deleted"].map((v) => projectObject(v, keep)),
      "updated-before": result["updated-before"].map((v) => projectObject(v, keep)),
      "updated-after": result["updated-after"].map((v) => projectObject(v, keep)),
    };
  }

  // Defaults to `false` for a query (before and after are always identical
  // copies there, so filling both is pure duplication) and to `true`
  // otherwise (create/update/delete's before and after differ and both
  // carry information) — see packages/core/docs/spec/model-command-language.md#command's "Result
  // shaping".
  const fillBefore = options?.before ?? kind !== "query";
  if (!fillBefore) {
    shaped = { ...shaped, before: [], "updated-before": [] };
  }

  return shaped;
}

/**
 * The only properties a resolved command mapping may carry — `command`'s own
 * (`kind`/`schema`/`namespace`/`filters`/`input`) plus `as`, which
 * `script_command` adds (packages/core/docs/spec/model-command-language.md#script: "extends
 * command" for a result name). `resolveCommandForm` doesn't distinguish a
 * bare `command` from a `script_command` — both funnel through the same
 * function (see api.ts's `runCommand`/`runScript`, and the REPL's
 * commandBlock.ts) — so `as` is allowed universally rather than rejected on
 * a plain (non-script) command; an `as` outside a script is harmless, just
 * unused.
 */
const ALLOWED_COMMAND_KEYS = new Set(["kind", "schema", "namespace", "filters", "input", "cascade", "result", "as"]);

/** The only keys `result` may carry — packages/core/docs/spec/model-command-language.md#command's "Result shaping". */
const ALLOWED_RESULT_KEYS = new Set(["properties", "before"]);

/**
 * Structural validation of `result`, done here rather than in shapeResult
 * below so a malformed option is caught before anything runs — the same
 * reason `unknown_command_property` is checked at resolution time. Whether
 * the *names* in `properties` exist is a question for the target schema, so
 * that half lives in shapeResult, which has the resolvers.
 */
function validateResultOptions(raw: unknown): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw modelError("unknown_result_option", "`result` must be a mapping of properties/before");
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !ALLOWED_RESULT_KEYS.has(k));
  if (unknown.length > 0) {
    throw modelError(
      "unknown_result_option",
      `unrecognized result option${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => `"${k}"`).join(", ")} — expected one of properties, before`,
    );
  }
  if (obj.properties !== undefined && (!Array.isArray(obj.properties) || obj.properties.some((p) => typeof p !== "string"))) {
    throw modelError("unknown_result_option", "`result.properties` must be an array of property names");
  }
  if (obj.before !== undefined && typeof obj.before !== "boolean") {
    throw modelError("unknown_result_option", "`result.before` must be a boolean");
  }
}

/**
 * Resolves a command's authored (possibly sugared) form to its canonical
 * `kind`/`schema` shape, per packages/core/docs/spec/model-command-language.md#command's
 * "Authored form": `query`/`create`/`update`/`delete` are also accepted as
 * top-level keys — the key names `kind`, its value names `schema`. Exactly
 * one of `kind` or one sugar key must be given. Idempotent: a command
 * already in canonical form (or holding neither) passes straight through to
 * the relevant error/no-op, so calling it more than once on the same value
 * down a call chain is harmless.
 *
 * Also rejects any property outside `ALLOWED_COMMAND_KEYS` with
 * `unknown_command_property` — added so a misspelled property (`filter` for
 * `filters`) is caught here instead of being silently dropped and its
 * property falling back to its default. That default is particularly sharp
 * for `filters`: an absent filter matches every instance (see
 * matchFilter in filter.ts), so a typo'd `filters` on `update`/`delete`
 * used to silently target the whole schema instead of throwing.
 */
export function resolveCommandForm(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw modelError("missing_command_kind", "a command must be a mapping");
  }
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const sugarKeys = COMMAND_KINDS.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
  const hasKind = Object.prototype.hasOwnProperty.call(obj, "kind");

  if (sugarKeys.length > 1) {
    throw modelError("ambiguous_command_kind", `only one of ${sugarKeys.join(", ")} may be given`);
  }
  if (hasKind && sugarKeys.length === 1) {
    throw modelError("ambiguous_command_kind", `"kind" and "${sugarKeys[0]}" cannot both be given`);
  }
  if (!hasKind && sugarKeys.length === 0) {
    throw modelError("missing_command_kind", '"kind" is required, or one of query/create/update/delete');
  }

  if (sugarKeys.length === 1) {
    const kind = sugarKeys[0];
    const schemaValue = obj[kind];
    delete obj[kind];
    obj.kind = kind;
    obj.schema = schemaValue;
  }

  const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_COMMAND_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw modelError(
      "unknown_command_property",
      `unrecognized command propert${unknownKeys.length === 1 ? "y" : "ies"} ${unknownKeys.map((k) => `"${k}"`).join(", ")} — expected one of kind, schema, namespace, filters, input, cascade, result, as`,
    );
  }
  if (obj.cascade !== undefined) {
    if (obj.kind !== "delete") throw modelError("constraint_violation", `"cascade" belongs to a delete, not to a ${String(obj.kind)}`);
    if (typeof obj.cascade !== "boolean") throw modelError("constraint_violation", `"cascade" is a boolean`);
  }

  validateResultOptions(obj.result);

  return obj;
}

function coerceScalar(value: TransientValue, base: "string" | "number" | "integer" | "boolean"): TransientValue {
  if (value === null) return null;
  switch (base) {
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "integer":
      return typeof value === "number" ? Math.trunc(value) : Math.trunc(Number(value));
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return Boolean(value);
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/**
 * The value a map entry must have for the value type's base: a string, a
 * boolean, a number, or an integer. Nothing is coerced — `5` is not the string
 * `"5"` — because a map is validated entry by entry as given.
 */
function checkMapEntry(where: string, key: string, value: TransientValue, base: "string" | "number" | "integer" | "boolean"): TransientValue {
  const ok =
    base === "string"
      ? typeof value === "string"
      : base === "boolean"
        ? typeof value === "boolean"
        : base === "integer"
          ? Number.isInteger(value)
          : typeof value === "number";
  if (!ok) throw modelError("constraint_violation", `entry "${key}" of ${where} must be a ${base}, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * Whether a mapping patch value for a map property is a map operation rather
 * than a literal map: it has the single key `set` or `remove`, and that name is
 * not a valid key of the map type (a map keyed by any identifier takes `set`
 * as an ordinary key).
 */
function isMapOperation(resolved: Extract<ResolvedType, { kind: "map" }>, mapping: Record<string, TransientValue>): boolean {
  const keys = Object.keys(mapping);
  if (keys.length !== 1 || (keys[0] !== "set" && keys[0] !== "remove")) return false;
  try {
    validateScalarValue("key", resolved.key.base, keys[0], { ...resolved.key.constraints });
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolves the map operation `operation` on the property `prop` of an instance
 * whose current map is `current`, and returns the map the patch sets: `set`
 * merges its entries over the current ones, `remove` drops the entries of its
 * keys. A current value of `null` is `{}`. The result is validated like any
 * patch value afterwards. Throws `invalid_map_operation` for an operand of the
 * wrong shape.
 */
function resolveMapOperation(
  prop: NormalizedProperty,
  schemaName: string,
  current: TransientValue | undefined,
  operation: Record<string, TransientValue>,
): TransientObject {
  const where = `"${prop.name}" on "${schemaName}"`;
  const entries: TransientObject = isPlainObject(current) ? { ...current } : {};
  if ("set" in operation) {
    const operand = operation.set;
    if (!isPlainObject(operand)) throw modelError("invalid_map_operation", `"set" on ${where} takes a mapping of entries`);
    return { ...entries, ...operand };
  }
  const operand = operation.remove;
  if (!Array.isArray(operand) || operand.some((key) => typeof key !== "string")) {
    throw modelError("invalid_map_operation", `"remove" on ${where} takes an array of keys`);
  }
  for (const key of operand as string[]) delete entries[key];
  return entries;
}

/**
 * What a mapping patch value stands for: on a map property, a map operation
 * resolved against the current map, or else a literal map; on any other
 * property, a text operation resolved against the current text.
 */
function resolvePatchMapping(
  prop: NormalizedProperty,
  resolved: ResolvedType,
  schemaName: string,
  current: TransientValue | undefined,
  mapping: Record<string, TransientValue>,
): TransientValue {
  if (resolved.kind !== "map") return resolveTextOperation(prop, resolved, schemaName, current, mapping);
  return isMapOperation(resolved, mapping) ? resolveMapOperation(prop, schemaName, current, mapping) : mapping;
}

/**
 * The value of a map property: `{}` when the property is absent or null,
 * otherwise the mapping given, each entry checked to hold a value of the value
 * type. Keys, constraints and entry counts are validated by `validateMapValue`.
 */
function computeMapValue(
  prop: NormalizedProperty,
  hasProvided: boolean,
  providedRaw: TransientValue | undefined,
  resolved: Extract<ResolvedType, { kind: "map" }>,
  schemaName: string,
): TransientObject {
  if (!hasProvided || providedRaw === null || providedRaw === undefined) return {};
  const where = `"${prop.name}" on "${schemaName}"`;
  if (!isPlainObject(providedRaw)) {
    throw modelError("constraint_violation", `${where} is a map and takes a mapping of entries`);
  }
  if (isMapOperation(resolved, providedRaw)) {
    throw modelError("constraint_violation", `${where} is a map; a map operation ("set", "remove") only an update applies`);
  }
  const map: TransientObject = {};
  for (const [key, value] of Object.entries(providedRaw)) {
    map[key] = checkMapEntry(where, key, value, resolved.value.base);
  }
  return map;
}

/**
 * Validates the value of a map property: a mapping, whose number of entries
 * respects the property's `min_length` and `max_length`, each key valid for the
 * key type and each value for the value type. `null` and an absent value are
 * the empty map.
 */
function validateMapValue(
  propName: string,
  resolved: Extract<ResolvedType, { kind: "map" }>,
  propConstraints: Record<string, TransientValue>,
  value: TransientValue | undefined,
): void {
  const current = value === null || value === undefined ? {} : value;
  if (!isPlainObject(current)) {
    throw modelError("constraint_violation", `"${propName}" is a map and must be a mapping of entries`);
  }
  const entries = Object.entries(current);
  if (typeof propConstraints.min_length === "number" && entries.length < propConstraints.min_length) {
    throw modelError("constraint_violation", `"${propName}" has fewer than ${propConstraints.min_length} entries`);
  }
  if (typeof propConstraints.max_length === "number" && entries.length > propConstraints.max_length) {
    throw modelError("constraint_violation", `"${propName}" has more than ${propConstraints.max_length} entries`);
  }
  for (const [key, entry] of entries) {
    validateScalarValue(`${propName} key "${key}"`, resolved.key.base, key, { ...resolved.key.constraints });
    checkMapEntry(`"${propName}"`, key, entry, resolved.value.base);
    validateScalarValue(`${propName}.${key}`, resolved.value.base, entry, { ...resolved.value.constraints });
  }
}

function computePropertyValue(
  prop: NormalizedProperty,
  hasProvided: boolean,
  providedRaw: TransientValue | undefined,
  resolved: ResolvedType,
  instanceSoFar: TransientObject,
  schema: NormalizedSchema,
  datasetValue: TransientValue,
): TransientValue {
  const isArray = prop.constraints.is_array === true;
  if (resolved.kind === "map") {
    if (!hasProvided && prop.default_value !== null) {
      // a mapping written as such, or one whole placeholder giving one
      const value = substitutePlaceholders(prop.default_value, { this: { ...instanceSoFar, schema: schema as unknown as TransientObject }, dataset: datasetValue });
      return computeMapValue(prop, true, value, resolved, schema.name);
    }
    return computeMapValue(prop, hasProvided, providedRaw, resolved, schema.name);
  }

  // `this.schema` is the root packages/core/docs/spec/meta-model.md#placeholders names
  // for the schema of the instance under construction — layered over the
  // instance rather than kept beside it, so `${this.schema.name}` reaches the
  // schema even on an instance whose own properties include one called
  // `schema`. The schema is already a plain nested value (see types.ts's note
  // on NormalizedSchema being stored through putInstance unchanged), which is
  // all the placeholder walker needs.
  const context = {
    this: { ...instanceSoFar, schema: schema as unknown as TransientObject },
    dataset: datasetValue,
  };

  if (resolved.kind === "relation") {
    if (hasProvided) return providedRaw === undefined ? null : providedRaw;
    // a default that is a key, or one whole placeholder giving one
    if (prop.default_value !== null && !isArray) {
      const key = substitutePlaceholders(prop.default_value, context);
      return key === "" || key === undefined ? null : key;
    }
    return isArray ? [] : null;
  }

  // scalar
  if (!hasProvided && isArray && prop.default_value !== null) {
    // a list written as such, or one whole placeholder giving one; a single value is a list of one
    const resolvedVal = substitutePlaceholders(prop.default_value, context);
    const values = (Array.isArray(resolvedVal) ? resolvedVal : resolvedVal === null || resolvedVal === "" ? [] : [resolvedVal]).map((v) =>
      coerceScalar(v, resolved.base),
    );
    return prop.constraints.is_set === true ? canonicalSet(prop.name, values, { ...resolved.constraints, ...prop.constraints }) : values;
  }
  if (hasProvided) {
    if (providedRaw === null || providedRaw === undefined) {
      const raw = prop.null_value;
      if (raw === null) return scalarNullValue(resolved);
      const resolvedVal = substitutePlaceholders(raw, context);
      return coerceScalar(resolvedVal, resolved.base);
    }
    // A mapping is a text operation, which only an update resolves (before it
    // gets here); on a create it would otherwise be stored as "[object Object]".
    if (isPlainObject(providedRaw)) {
      throw modelError("constraint_violation", `"${prop.name}" on "${schema.name}" is a scalar; a mapping value is a text operation, which only an update applies`);
    }
    if (isArray && Array.isArray(providedRaw)) {
      const values = providedRaw.map((v) => coerceScalar(v, resolved.base));
      return prop.constraints.is_set === true ? canonicalSet(prop.name, values, { ...resolved.constraints, ...prop.constraints }) : values;
    }
    return coerceScalar(providedRaw, resolved.base);
  }
  if (isArray) return [];
  if (prop.default_value !== null) {
    const resolvedVal = substitutePlaceholders(prop.default_value, context);
    return coerceScalar(resolvedVal, resolved.base);
  }
  return scalarDefaultValue(resolved);
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;

/**
 * The `default_value` of `prop` with every placeholder that crosses a relation
 * of `schema` (`${this.type.default_scope}`) replaced by the value it reads,
 * since `computePropertyValue`, which resolves the others, reads no instance
 * (see Placeholders, *Across relations*). A whole placeholder keeps the type of
 * its value. A path that meets a null relation, or reaches no value, gives
 * `null`: the property then takes its ordinary default. Any other placeholder
 * is left for `computePropertyValue`.
 */
async function crossRelations(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  prop: NormalizedProperty,
  instanceSoFar: TransientObject,
): Promise<NormalizedProperty["default_value"]> {
  const crossing = (content: string): string[] | undefined => {
    const path = content.trim().split(".");
    if (path[0] !== "this" || path.length < 3) return undefined;
    const first = findProperty(schema, path[1]);
    if (!first || first.constraints.is_array === true) return undefined;
    return resolveType(first.type, resolvers.ctx).kind === "relation" ? path.slice(1) : undefined;
  };
  const ctx = { ...resolvers.ctx, impl, rest };
  let missing = false;
  const rewrite = async (value: TransientValue): Promise<TransientValue> => {
    if (typeof value === "string") {
      const whole = /^\$\{([^}]*)\}$/.exec(value.trim());
      if (whole) {
        const path = crossing(whole[1]);
        if (!path) return value;
        const found = await valueOnPath(instanceSoFar, schema, path, ctx);
        if (found === undefined) missing = true;
        return found ?? null;
      }
      let out = "";
      let last = 0;
      for (const match of value.matchAll(PLACEHOLDER)) {
        const path = crossing(match[1]);
        out += value.slice(last, match.index);
        last = (match.index as number) + match[0].length;
        if (!path) {
          out += match[0];
          continue;
        }
        const found = await valueOnPath(instanceSoFar, schema, path, ctx);
        if (found === undefined) missing = true;
        out += found === undefined || found === null ? "" : typeof found === "object" ? JSON.stringify(found) : String(found);
      }
      return out + value.slice(last);
    }
    if (Array.isArray(value)) return Promise.all(value.map(rewrite));
    if (value !== null && typeof value === "object") {
      const out: TransientObject = {};
      for (const [k, v] of Object.entries(value)) out[k] = await rewrite(v);
      return out;
    }
    return value;
  };
  const template = prop.default_value;
  if (template === null) return null;
  const rewritten = await rewrite(template as TransientValue);
  if (missing) return null;
  return rewritten as NormalizedProperty["default_value"];
}

/** Whether a default reads a placeholder that may cross a relation, so `crossRelations` must run before the instance is built. */
function mayCrossRelations(prop: NormalizedProperty): boolean {
  return prop.default_value !== null && /\$\{\s*this\.[A-Za-z_][A-Za-z0-9_]*\./.test(JSON.stringify(prop.default_value));
}

/**
 * Whether `value` is no value for `set_once` (see Property Constraints): a null
 * relation, or a scalar equal to the default of its base type.
 */
function isNoValue(value: TransientValue | undefined, resolved: ResolvedType): boolean {
  if (value === null || value === undefined) return true;
  return resolved.kind === "scalar" && value === scalarDefaultValue(resolved);
}

/** Whether the constraints of a property require its entries to be distinct: `is_set` and `is_unique`. */
function requiresDistinct(constraints: Record<string, TransientValue>): boolean {
  return constraints.is_set === true || constraints.is_unique === true;
}

/** Refuses a value of an `is_set` or `is_unique` property that holds the same entry twice, with `constraint_violation`. */
function assertDistinct(propName: string, values: TransientValue[]): void {
  const seen = new Set<string>();
  for (const v of values) {
    const entry = String(v);
    if (seen.has(entry)) {
      throw modelError("constraint_violation", `"${propName}" holds ${JSON.stringify(v)} more than once and its entries must be distinct`);
    }
    seen.add(entry);
  }
}

/**
 * The stored form of the value of an `is_set` property: free of duplicates
 * (`constraint_violation` otherwise) and listed in the declaration order of the
 * `enum` in `eff`, so that two equal sets are stored identically. An entry the
 * `enum` does not hold goes last; `validateInstance` refuses it right after.
 */
function canonicalSet(propName: string, values: TransientValue[], eff: Record<string, TransientValue>): TransientValue[] {
  assertDistinct(propName, values);
  const order = Array.isArray(eff.enum) ? eff.enum.map((e) => String(e)) : [];
  const rank = (v: TransientValue): number => {
    const index = order.indexOf(String(v));
    return index < 0 ? order.length : index;
  };
  return [...values].sort((a, b) => rank(a) - rank(b));
}

function validateScalarValue(propName: string, base: string, value: TransientValue, eff: Record<string, TransientValue>) {
  if (value === null) return;
  if (Array.isArray(eff.enum)) {
    if (!eff.enum.some((e) => String(e) === String(value))) {
      throw modelError("constraint_violation", `"${propName}" must be one of ${JSON.stringify(eff.enum)}, got ${JSON.stringify(value)}`);
    }
  }
  if (base === "string" && typeof eff.pattern === "string" && eff.pattern !== "") {
    if (!new RegExp(eff.pattern).test(String(value))) {
      throw modelError("constraint_violation", `"${propName}" does not match pattern ${eff.pattern}`);
    }
  }
  if ((base === "number" || base === "integer") && typeof value !== "undefined") {
    const n = Number(value);
    if (typeof eff.minimum === "number" && n < eff.minimum) throw modelError("constraint_violation", `"${propName}" below minimum`);
    if (typeof eff.maximum === "number" && n > eff.maximum) throw modelError("constraint_violation", `"${propName}" above maximum`);
    if (typeof eff.exclusive_minimum === "number" && n <= eff.exclusive_minimum)
      throw modelError("constraint_violation", `"${propName}" not above exclusive minimum`);
    if (typeof eff.exclusive_maximum === "number" && n >= eff.exclusive_maximum)
      throw modelError("constraint_violation", `"${propName}" not below exclusive maximum`);
    if (typeof eff.multiple_of === "number" && eff.multiple_of !== 0 && n % eff.multiple_of !== 0)
      throw modelError("constraint_violation", `"${propName}" is not a multiple of ${eff.multiple_of}`);
  }
}

/**
 * Validates `instance` against `schema`'s constraints. Returns `true` when
 * this is an `update` (`options.isUpdate`) that leaves an otherwise-owned
 * instance with no owner at all — per packages/core/docs/spec/meta-model.md#ownership,
 * "When an instance is updated if it loses its owner it is automatically
 * deleted," not rejected. The caller (runCommand's `update` case) is the one
 * that actually performs that deletion; this function only detects the
 * condition, since it has no business writing to storage itself. `create`
 * (`!options.isUpdate`) still throws for a missing owner — "When an instance
 * is created it must have an owner" — and *more than one* owner is always a
 * `constraint_violation`, update or not (see packages/core/docs/spec/meta-model.md#ownership's
 * "on an instance one and only one will be non null at any time").
 */
function validateInstance(
  schema: NormalizedSchema,
  instance: TransientObject,
  resolvers: Resolvers,
  options: { isUpdate: boolean },
): boolean {
  for (const prop of schema.properties) {
    const value = instance[prop.name];
    // an unset value of a facet is valid: it is stored by omission
    if (facetOfProperty(prop) !== undefined && (value === undefined || value === null)) continue;
    const resolved = resolveType(prop.type, resolvers.ctx);
    const isArray = prop.constraints.is_array === true;

    if (resolved.kind === "relation") {
      if (prop.constraints.mandatory === true) {
        const empty = isArray ? !Array.isArray(value) || value.length === 0 : value === null || value === undefined;
        if (empty) throw modelError("constraint_violation", `"${prop.name}" is mandatory on "${schema.name}"`);
      }
      continue;
    }

    if (resolved.kind === "map") {
      validateMapValue(prop.name, resolved, prop.constraints, value);
      continue;
    }

    const eff = { ...resolved.constraints, ...prop.constraints };
    if (isArray) {
      if (typeof prop.constraints.min_length === "number" && (!Array.isArray(value) || value.length < prop.constraints.min_length)) {
        throw modelError("constraint_violation", `"${prop.name}" has fewer than ${prop.constraints.min_length} elements`);
      }
      if (typeof prop.constraints.max_length === "number" && Array.isArray(value) && value.length > prop.constraints.max_length) {
        throw modelError("constraint_violation", `"${prop.name}" has more than ${prop.constraints.max_length} elements`);
      }
      if (requiresDistinct(prop.constraints)) assertDistinct(prop.name, Array.isArray(value) ? value : []);
      for (const v of Array.isArray(value) ? value : []) validateScalarValue(prop.name, resolved.base, v, eff);
    } else {
      validateScalarValue(prop.name, resolved.base, value, eff);
    }
  }

  if (!isRoot(schema)) {
    const owners = ownerProperties(schema);
    if (owners.length > 0) {
      const nonNull = owners.filter((p) => instance[p.name] !== null && instance[p.name] !== undefined).length;
      if (nonNull > 1) {
        throw modelError("constraint_violation", `"${schema.name}" instance must have exactly one owner (has ${nonNull})`);
      }
      if (nonNull === 0) {
        if (!options.isUpdate) {
          throw modelError("constraint_violation", `"${schema.name}" instance must have exactly one owner (has ${nonNull})`);
        }
        return true;
      }
    }
  }
  return false;
}

function toKeyArray(value: TransientValue | undefined): Key[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

interface Accumulator {
  updatedBefore: TransientValue[];
  updatedAfter: TransientValue[];
  cascadeDeleted: TransientValue[];
  /** The `cascade` of the delete: whether `confirm` relations cascade. */
  cascade?: boolean;
  /** The instances `performDelete` has started removing, as `removalId`s: a relation cycle of `cascade` ends there. */
  deleting?: Set<string>;
}

/**
 * Finds a stored instance by key when the property that names it is typed to
 * a schema that may be more general than what's actually on disk — a
 * relation declared `document_part` can point at a `document_part_concept`,
 * `owning_document` declared `document` at a `document_guide`, and so on. A
 * plain `impl.getInstance(declaredSchema, key)` only ever finds an instance
 * actually stored under that exact schema name, since a persistent format
 * indexes a note by its own `_schema` (the leaf schema it was created with),
 * never an ancestor's — so this tries the declared schema first, then every
 * schema extending it (the same set `collectExtendingSchemas` gives the
 * `query`/`update`/`delete` matcher above), and returns whichever one the
 * instance actually turns out to be.
 */
async function findInstanceByKey(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  declaredSchema: NormalizedSchema,
  key: Key,
): Promise<{ schema: NormalizedSchema; instance: TransientObject; roles: Record<string, string> } | null> {
  for (const candidate of collectExtendingSchemas(declaredSchema, resolvers)) {
    const roles = derivePropertyRoles(candidate);
    const instance = await impl.getInstance(rest, candidate.name, key, roles);
    if (instance !== null) return { schema: candidate, instance: instance as TransientObject, roles };
  }
  return null;
}

/**
 * The topmost schema in `schema`'s `extends` chain that still declares this
 * exact relation property (same name, same `inverse_name`) — a reverse join
 * (`liveInverseKeys`) has to scan the *whole* declaring family sharing this
 * property, not just whichever leaf schema an instance actually happens to
 * be stored under.
 */
function declaringRootSchema(schema: NormalizedSchema, resolvers: Resolvers, prop: NormalizedProperty): NormalizedSchema {
  let current = schema;
  while (current.extends) {
    const parent = resolvers.schemas.get(current.extends);
    if (!parent) break;
    const parentProp = parent.properties.find(
      (p) => p.name === prop.name && p.constraints.inverse_name === prop.constraints.inverse_name,
    );
    if (!parentProp) break;
    current = parent;
  }
  return current;
}

/**
 * Per-`executeCommand`-call cache for the live join a virtual relation reads
 * from — keyed by `${declaringRootSchema.name}::${prop.name}`, each entry a
 * (lazily built, memoized) `targetKey -> [keys]` reverse index over that
 * declaring family. Without it, `liveInverseKeys`
 * would rescan the whole declaring family from scratch for every candidate
 * instance being resolved (O(N x family size) for an N-instance query);
 * with it, the family is scanned once per (declaringRoot, prop) pair for the
 * whole command, and every candidate after the first is an O(1) map lookup.
 * Instantiated fresh in `executeCommand` and threaded through every call
 * below that resolves a virtual relation — never reused across two
 * `executeCommand` calls (see `runUpdateOne`'s recursive `runCommand`),
 * since a command earlier in the same script, or a write earlier in this
 * same command, may have changed the very data the index would reflect.
 */
type LiveJoinCache = Map<string, Promise<Map<Key, Key[]>>>;

function liveJoinCacheKey(declaringRoot: NormalizedSchema, prop: NormalizedProperty): string {
  return `${declaringRoot.name}::${prop.name}`;
}

/**
 * Scans every `root`-family instance exactly once, building the full
 * `targetKey -> [keys]` reverse index `liveInverseKeys` reads from — the
 * one-time cost `LiveJoinCache` amortizes across every candidate and every
 * virtual property that shares this same (declaringRoot, prop) pair within
 * one command.
 */
async function buildLiveJoinIndex(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  root: NormalizedSchema,
  prop: NormalizedProperty,
): Promise<Map<Key, Key[]>> {
  const index = new Map<Key, Key[]>();
  for (const candidate of collectExtendingSchemas(root, resolvers)) {
    const roles = derivePropertyRoles(candidate);
    for (const raw of await impl.listInstances(rest, candidate.name, roles)) {
      const obj = raw as TransientObject;
      const candidateKey = keyOf(candidate, obj);
      for (const target of toKeyArray(obj[prop.name])) {
        const bucket = index.get(target);
        if (bucket) bucket.push(candidateKey);
        else index.set(target, [candidateKey]);
      }
    }
  }
  return index;
}

/**
 * Every key of a `declaringSchema`-family instance whose `prop` currently
 * references `targetKey` — the live join a virtual (generated) relation's
 * value is computed from, per packages/core/docs/spec/meta-model.md#relations: "The
 * generic layer computes its value on demand — a join over the declaring
 * schema's instances, matching on the declaring property". Reads from
 * `cache`'s per-command reverse index (building it on first use for this
 * (declaringRoot, prop) pair) instead of scanning the family itself — see
 * `LiveJoinCache`.
 */
async function liveInverseKeys(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  declaringSchema: NormalizedSchema,
  prop: NormalizedProperty,
  targetKey: Key,
  cache: LiveJoinCache,
): Promise<Key[]> {
  const root = declaringRootSchema(declaringSchema, resolvers, prop);
  const cacheKey = liveJoinCacheKey(root, prop);
  let indexPromise = cache.get(cacheKey);
  if (!indexPromise) {
    indexPromise = buildLiveJoinIndex(impl, rest, resolvers, root, prop);
    cache.set(cacheKey, indexPromise);
  }
  const index = await indexPromise;
  return index.get(targetKey) ?? [];
}

/**
 * Fills every generated (virtual) relation property on `instance` with its
 * live-joined value. Mutates and returns `instance`; callers that need to
 * keep the original pass a clone.
 */
async function resolveVirtualProperties(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  instance: TransientObject,
  cache: LiveJoinCache,
): Promise<TransientObject> {
  const key = keyOf(schema, instance);
  // the values of its facets are read in, under their qualified names, so every reader sees them
  await mergeFacetValues(impl, rest, resolvers.ctx, schema, key, instance);
  return resolveInverseRelations(impl, rest, resolvers, schema, instance, cache);
}

/** The generated (inverse) relations of `instance`, computed by a live join. */
async function resolveInverseRelations(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  instance: TransientObject,
  cache: LiveJoinCache,
): Promise<TransientObject> {
  const key = keyOf(schema, instance);
  for (const prop of schema.properties) {
    if (prop.constraints.__generated !== true) continue;
    const inv = findInverseProperty(resolvers, schema, prop.name);
    if (!inv) continue;
    const keys = await liveInverseKeys(impl, rest, resolvers, inv.sourceSchema, inv.sourceProp, key, cache);
    instance[prop.name] = prop.constraints.is_array === true ? keys : (keys[0] ?? null);
  }
  return instance;
}

/**
 * Strips every generated (virtual) relation property from `instance` before
 * it reaches a persistent format — per packages/core/docs/spec/meta-model.md#relations,
 * "a virtual relation is never stored: a persistent format never sees it, in
 * putInstance's instance argument or anywhere else."
 */
function withoutVirtualRelations(schema: NormalizedSchema, instance: TransientObject): TransientObject {
  const stripped: TransientObject = { ...instance };
  for (const prop of schema.properties) {
    if (prop.constraints.__generated === true || facetOfProperty(prop) !== undefined) {
      delete stripped[prop.name];
    }
  }
  return stripped;
}

/**
 * Reports (but never writes) a target instance's generated inverse property
 * changing as a side effect of `sourceSchema`'s own `sourceKey` instance's
 * `prop` changing from `oldValue` to `newValue` — per
 * packages/core/docs/spec/meta-model.md#relations, the value is computed on demand,
 * never stored, so there is nothing here to write to the target; the target
 * instance itself already reflects the current, correct state the next time
 * anything reads it through resolveVirtualProperties.
 *
 * `sourceKey`'s own current row is excluded from the live join and added
 * back manually (present in the "before" set when `targetKey` was in
 * `oldKeys`, in the "after" set when it was in `newKeys`) so the result is
 * correct regardless of whether the caller has already written `sourceKey`'s
 * new value to storage by the time this runs (create/update do; delete does
 * not, since the instance is about to be removed) or not yet.
 */
async function propagateInverseChange(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  sourceSchema: NormalizedSchema,
  sourceKey: Key,
  prop: NormalizedProperty,
  oldValue: TransientValue | undefined,
  newValue: TransientValue | undefined,
  acc: Accumulator,
  cache: LiveJoinCache,
) {
  if (typeof prop.constraints.inverse_name !== "string") return;
  // the name of the virtual relation on the target, qualified when it comes from another module
  const inverseName = generatedInverseName(declaringRootSchema(sourceSchema, resolvers, prop).name, prop);
  const inverseIsArray = prop.constraints.inverse_is_array === true;
  const targetSchemaName = prop.type;
  const targetSchema = resolvers.schemas.get(targetSchemaName);

  const oldKeys = toKeyArray(oldValue);
  const newKeys = toKeyArray(newValue);
  const removed = oldKeys.filter((k) => !newKeys.includes(k));
  const added = newKeys.filter((k) => !oldKeys.includes(k));

  for (const targetKey of [...removed, ...added]) {
    // targetSchemaName is the relation's *declared* target, which a stored
    // instance may be a more specific descendant of (see findInstanceByKey).
    const found = targetSchema ? await findInstanceByKey(impl, rest, resolvers, targetSchema, targetKey) : null;
    if (!found) continue;
    const others = (await liveInverseKeys(impl, rest, resolvers, sourceSchema, prop, targetKey, cache)).filter((k) => k !== sourceKey);
    const beforeKeys = oldKeys.includes(targetKey) ? [...others, sourceKey] : others;
    const afterKeys = newKeys.includes(targetKey) ? [...others, sourceKey] : others;
    const resolved = await resolveVirtualProperties(impl, rest, resolvers, found.schema, clone(found.instance) as TransientObject, cache);
    acc.updatedBefore.push({ ...resolved, [inverseName]: inverseIsArray ? beforeKeys : (beforeKeys[0] ?? null) });
    acc.updatedAfter.push({ ...resolved, [inverseName]: inverseIsArray ? afterKeys : (afterKeys[0] ?? null) });
  }
}

/**
 * On a direct (non-cascade) delete, removes `key` from its true owner's own
 * real, stored array/scalar when that ownership is expressed through a
 * *generated* owner property (e.g. `thing.box`, generated from
 * `owner_box.things`'s `owns` + `inverse_name`) — nothing else does this
 * once the generated property itself is never stored, so without it a
 * direct delete would leave a dangling key in the owner's array.
 * Skipped for a cascade delete: the owner is
 * itself being deleted, so its array is about to disappear too. A
 * *declared* owner property (e.g. `comment.task`) needs no action here —
 * its value lives on the instance being deleted, which is already going
 * away; there is nothing stored elsewhere to detach.
 */
async function detachFromOwner(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  key: Key,
  resolved: TransientObject,
): Promise<void> {
  for (const ownerProp of ownerProperties(schema)) {
    if (ownerProp.constraints.__generated !== true) continue;
    const inv = findInverseProperty(resolvers, schema, ownerProp.name);
    if (!inv) continue;
    const ownerKey = resolved[ownerProp.name];
    if (typeof ownerKey !== "string") continue;
    const found = await findInstanceByKey(impl, rest, resolvers, inv.sourceSchema, ownerKey);
    if (!found) continue;
    const ownerObj = found.instance as TransientObject;
    const currentKeys = toKeyArray(ownerObj[inv.sourceProp.name]);
    if (!currentKeys.includes(key)) continue;
    const newKeys = currentKeys.filter((k) => k !== key);
    const newValue: TransientValue = inv.sourceProp.constraints.is_array === true ? newKeys : (newKeys[0] ?? null);
    await impl.putInstance(rest, found.schema.name, ownerKey, { ...ownerObj, [inv.sourceProp.name]: newValue }, found.roles);
  }
}

/** The identity of an instance within one delete: its schema and its key. */
function removalId(schema: NormalizedSchema, key: Key): string {
  return `${schema.name}\u0000${key}`;
}

/**
 * What the deletion of the target does to the instance declaring `prop`: its
 * `on_delete`, else `restrict` when the relation is `mandatory` and `set_null`
 * when it is not (see the part `on_delete` of the document `model`).
 */
function onDeleteOf(prop: NormalizedProperty): OnDelete {
  const declared = prop.constraints.on_delete;
  if (declared === "restrict" || declared === "cascade" || declared === "set_null" || declared === "confirm") return declared;
  return prop.constraints.mandatory === true ? "restrict" : "set_null";
}

/** Whether the delete removes the instances reached through `mode`: `cascade` always, `confirm` with `cascade: true`. */
function removesWith(mode: OnDelete, cascade: boolean): boolean {
  return mode === "cascade" || (mode === "confirm" && cascade);
}

/** An instance whose relation `prop` points at a given instance, with the effect `mode` of deleting it. */
interface Referrer {
  schema: NormalizedSchema;
  key: Key;
  prop: NormalizedProperty;
  mode: OnDelete;
}

/**
 * The instances holding a relation to the instance `key` of `schema`. A
 * relation that is `owner`, `owns` or generated is not listed:
 * ownership removes the owned instance with its owner (see `performDelete`).
 */
async function findReferrers(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  key: Key,
): Promise<Referrer[]> {
  const found: Referrer[] = [];
  for (const [, refSchema] of resolvers.schemas) {
    // the relations of a facet are reached through its target, which carries them
    if (!keyPropertyName(refSchema) || isFacet(refSchema)) continue;
    const refProps = refSchema.properties.filter(
      (p) =>
        p.constraints.__generated !== true &&
        p.constraints.owner !== true &&
        p.constraints.owns !== true &&
        resolvers.schemas.has(p.type) &&
        isSchemaOrDescendant(schema, p.type, resolvers),
    );
    if (refProps.length === 0) continue;
    const readsFacet = refProps.some((p) => facetOfProperty(p) !== undefined);
    const candidates = await impl.listInstances(rest, refSchema.name, derivePropertyRoles(refSchema));
    for (const candidate of candidates) {
      const candKey = keyOf(refSchema, candidate);
      let values = candidate as TransientObject;
      if (readsFacet) values = await mergeFacetValues(impl, rest, resolvers.ctx, refSchema, candKey, { ...values });
      for (const prop of refProps) {
        if (values[prop.name] === key) found.push({ schema: refSchema, key: candKey, prop, mode: onDeleteOf(prop) });
      }
    }
  }
  return found;
}

/**
 * Everything one delete removes, from `roots`: the instances they own, the
 * instances an `owner` relation ties to them and the instances referencing
 * them through a `cascade` relation, transitively. Each entry carries its
 * referrers, which `assertDeletable` checks.
 */
async function planRemoval(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  roots: { schema: NormalizedSchema; key: Key }[],
  cascade: boolean,
): Promise<Map<string, { schema: NormalizedSchema; key: Key; referrers: Referrer[] }>> {
  const plan = new Map<string, { schema: NormalizedSchema; key: Key; referrers: Referrer[] }>();
  const pending = [...roots];
  while (pending.length > 0) {
    const { schema, key } = pending.pop() as { schema: NormalizedSchema; key: Key };
    if (plan.has(removalId(schema, key))) continue;
    const instance = await impl.getInstance(rest, schema.name, key, derivePropertyRoles(schema));
    if (!instance) continue;
    const obj = instance as TransientObject;
    const referrers = await findReferrers(impl, rest, resolvers, schema, key);
    plan.set(removalId(schema, key), { schema, key, referrers });

    for (const prop of schema.properties) {
      if (prop.constraints.owns !== true || typeof prop.constraints.inverse_name !== "string") continue;
      const targetSchema = resolvers.schemas.get(prop.type);
      for (const ownedKey of toKeyArray(obj[prop.name])) {
        const found = targetSchema ? await findInstanceByKey(impl, rest, resolvers, targetSchema, ownedKey) : null;
        const ownedSchema = found ? found.schema : targetSchema;
        if (ownedSchema) pending.push({ schema: ownedSchema, key: ownedKey });
      }
    }
    for (const [, targetSchema] of resolvers.schemas) {
      for (const ownerProp of ownerProperties(targetSchema)) {
        if (!isSchemaOrDescendant(schema, ownerProp.type, resolvers) || ownerProp.constraints.__generated === true) continue;
        const candidates = await impl.listInstances(rest, targetSchema.name, derivePropertyRoles(targetSchema));
        for (const candidate of candidates) {
          if ((candidate as TransientObject)[ownerProp.name] !== key) continue;
          const ownedKey = keyOf(targetSchema, candidate);
          // an owner relation with `on_delete: confirm` asks for consent: without it, the owned instance blocks the delete
          if (ownerProp.constraints.on_delete === "confirm" && !cascade) {
            referrers.push({ schema: targetSchema, key: ownedKey, prop: ownerProp, mode: "confirm" });
          } else {
            pending.push({ schema: targetSchema, key: ownedKey });
          }
        }
      }
    }
    for (const referrer of referrers) {
      if (removesWith(referrer.mode, cascade)) pending.push({ schema: referrer.schema, key: referrer.key });
    }
  }
  return plan;
}

/**
 * Refuses a delete, before anything is written, when an instance that stays
 * references one it removes through a `restrict` relation. An instance the
 * same delete removes does not block it.
 */
async function assertDeletable(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  roots: { schema: NormalizedSchema; key: Key }[],
  cascade = false,
): Promise<void> {
  const plan = await planRemoval(impl, rest, resolvers, roots, cascade);
  for (const { schema, key, referrers } of plan.values()) {
    for (const referrer of referrers) {
      const blocks = referrer.mode === "restrict" || (referrer.mode === "confirm" && !cascade);
      if (!blocks || plan.has(removalId(referrer.schema, referrer.key))) continue;
      throw modelError(
        "constraint_violation",
        referrer.mode === "confirm"
          ? `cannot delete "${key}" of "${schema.name}" without consent: "${referrer.key}" of "${referrer.schema.name}" goes with it through "${referrer.prop.name}" (on_delete: confirm) — delete with cascade: true`
          : `cannot delete "${key}" of "${schema.name}": "${referrer.key}" of "${referrer.schema.name}" references it through "${referrer.prop.name}", which restricts its deletion`,
      );
    }
  }
}

/** An instance named by the impact of a delete. */
export interface ImpactedInstance {
  schema: string;
  key: Key;
}

/** A `restrict` reference that refuses a delete: from an instance that stays to one it would remove. */
export interface BlockingReference extends ImpactedInstance {
  property: string;
  target: ImpactedInstance;
}

/** What a delete would do, given before it runs (see Action, Impact of a delete, in `docs/spec/meta-model.md`). */
export interface DeleteImpact {
  /** Each instance and facet instance the delete would remove. */
  removed: ImpactedInstance[];
  /** The references that refuse the delete; it runs only when there is none. */
  blocked: BlockingReference[];
}

/**
 * The impact of deleting the instances of `schemaName` matched by `filters`.
 * Writes nothing. Throws what a `query` of them throws.
 */
export async function deleteImpact(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schemaName: string,
  filters: CommandFilter | undefined,
): Promise<DeleteImpact> {
  const { after } = await runCommand(impl, rest, { kind: "query", schema: schemaName, filters }, resolvers);
  const declared = resolvers.schemas.get(schemaName) as NormalizedSchema;
  const roots: { schema: NormalizedSchema; key: Key }[] = [];
  for (const instance of after) {
    const key = keyOf(declared, instance);
    const found = await findInstanceByKey(impl, rest, resolvers, declared, key);
    roots.push({ schema: found ? found.schema : declared, key });
  }
  // the impact is what the delete would remove with `cascade: true`, so `confirm` relations are followed
  const plan = await planRemoval(impl, rest, resolvers, roots, true);
  const removed: ImpactedInstance[] = [];
  const blocked: BlockingReference[] = [];
  for (const { schema, key, referrers } of plan.values()) {
    removed.push({ schema: schema.name, key });
    for (const facetName of facetNamesOfSchema(schema)) {
      const facet = resolvers.ctx.resolveSchema(facetName);
      if (facet && (await impl.getInstance(rest, facetName, key, derivePropertyRoles(facet))) !== null) removed.push({ schema: facetName, key });
    }
    for (const referrer of referrers) {
      if (referrer.mode !== "restrict" || plan.has(removalId(referrer.schema, referrer.key))) continue;
      blocked.push({ schema: referrer.schema.name, key: referrer.key, property: referrer.prop.name, target: { schema: schema.name, key } });
    }
  }
  return { removed, blocked };
}

/**
 * Applies `set_null` to one referrer: its relation is cleared. The instance is
 * read again, since an earlier step of the same delete may have removed or
 * changed it; the instance as it was and as it is are reported in
 * `updated-before` and `updated-after`.
 */
async function clearReference(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  referrer: Referrer,
  acc: Accumulator,
  cache: LiveJoinCache,
): Promise<void> {
  const roles = derivePropertyRoles(referrer.schema);
  const stored = await impl.getInstance(rest, referrer.schema.name, referrer.key, roles);
  if (!stored) return;
  const current = await mergeFacetValues(
    impl,
    rest,
    resolvers.ctx,
    referrer.schema,
    referrer.key,
    { ...(stored as TransientObject) },
  );
  if (current[referrer.prop.name] === null || current[referrer.prop.name] === undefined) return;
  const updated: TransientObject = { ...current, [referrer.prop.name]: null };
  // a value of a facet is unset rather than set to null
  const isFacetValue = facetOfProperty(referrer.prop) !== undefined;
  if (isFacetValue) delete updated[referrer.prop.name];
  acc.updatedBefore.push(clone(await resolveVirtualProperties(impl, rest, resolvers, referrer.schema, clone(current) as TransientObject, cache)));
  await impl.putInstance(rest, referrer.schema.name, referrer.key, withoutVirtualRelations(referrer.schema, updated), roles);
  if (isFacetValue) await writeFacetValues(impl, rest, resolvers.ctx, referrer.schema, referrer.key, { [referrer.prop.name]: null });
  acc.updatedAfter.push(clone(await resolveVirtualProperties(impl, rest, resolvers, referrer.schema, clone(updated) as TransientObject, cache)));
}

async function performDelete(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  key: Key,
  acc: Accumulator,
  isCascade: boolean,
  cache: LiveJoinCache,
) {
  const roles = derivePropertyRoles(schema);
  const instance = await impl.getInstance(rest, schema.name, key, roles);
  if (!instance) return;
  const obj = instance as TransientObject;
  const resolved = await resolveVirtualProperties(impl, rest, resolvers, schema, clone(obj) as TransientObject, cache);

  const deleting = (acc.deleting ??= new Set<string>());
  if (deleting.has(removalId(schema, key))) return;
  deleting.add(removalId(schema, key));

  if (isCascade) {
    acc.cascadeDeleted.push(clone(resolved));
  } else {
    await detachFromOwner(impl, rest, resolvers, schema, key, resolved);
  }

  for (const prop of schema.properties) {
    if (typeof prop.constraints.inverse_name !== "string") continue;
    const isArray = prop.constraints.is_array === true;
    const oldValue = obj[prop.name];

    if (prop.constraints.owns === true) {
      // The owned children are this instance's own real, declared array/
      // scalar — read directly instead of scanning every other schema's
      // storage for a generated owner field that (per this redesign) is
      // never written in the first place. See packages/core/docs/spec/meta-model.md#relations's
      // "cascade-deletion ... must instead walk from the
      // owns side's own declared relation."
      const targetSchema = resolvers.schemas.get(prop.type);
      for (const ownedKey of toKeyArray(oldValue)) {
        const found = targetSchema ? await findInstanceByKey(impl, rest, resolvers, targetSchema, ownedKey) : null;
        const ownedSchema = found ? found.schema : targetSchema;
        if (ownedSchema) await performDelete(impl, rest, resolvers, ownedSchema, ownedKey, acc, true, cache);
      }
      continue;
    }

    await propagateInverseChange(impl, rest, resolvers, schema, key, prop, oldValue, isArray ? [] : null, acc, cache);
  }

  // The remaining case: a *declared* (non-generated) owner property on some
  // other schema (e.g. comment.task) — its value lives on the owning
  // instance itself, not on `schema`, so it can only be found by scanning.
  // A *generated* owner property targeting `schema` is always paired with an
  // `owns` relation declared on `schema` itself, already handled above.
  for (const [, targetSchema] of resolvers.schemas) {
    for (const ownerProp of ownerProperties(targetSchema)) {
      if (!isSchemaOrDescendant(schema, ownerProp.type, resolvers) || ownerProp.constraints.__generated === true || ownerProp.constraints.extension === true) continue;
      const candidates = await impl.listInstances(rest, targetSchema.name, derivePropertyRoles(targetSchema));
      for (const candidate of candidates) {
        const c = candidate as TransientObject;
        if (c[ownerProp.name] === key) {
          const candKey = keyOf(targetSchema, candidate);
          await performDelete(impl, rest, resolvers, targetSchema, candKey, acc, true, cache);
        }
      }
    }
  }

  // The instances referencing this one through a relation that is neither owner nor owns: `cascade` removes
  // them, `set_null` clears the relation, and `restrict` has been checked by `assertDeletable` before any write.
  for (const referrer of await findReferrers(impl, rest, resolvers, schema, key)) {
    if (referrer.schema.name === schema.name && referrer.key === key) continue;
    // `confirm` without consent was refused by `assertDeletable`, or the instance goes with this delete anyway
    if (removesWith(referrer.mode, acc.cascade === true)) {
      await performDelete(impl, rest, resolvers, referrer.schema, referrer.key, acc, true, cache);
    } else if (referrer.mode === "set_null") {
      await clearReference(impl, rest, resolvers, referrer, acc, cache);
    }
  }

  // the facet instances go with their target, whatever their module
  await deleteFacetInstances(impl, rest, resolvers.ctx, schema, key);
  await impl.deleteInstance(rest, schema.name, key);
}

/**
 * Whether a relation property carries no target: null/undefined, or an empty
 * array for a multiple relation. What `create` uses to tell a virtual
 * relation left at its default from one actually given a value.
 */
function isUnsetRelation(value: TransientValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  return Array.isArray(value) && value.length === 0;
}

interface InverseProperty {
  sourceSchema: NormalizedSchema;
  sourceProp: NormalizedProperty;
}

/**
 * Whether `schema` is `ancestorName` itself or extends it, directly or
 * transitively — the mirror image of `collectExtendingSchemas` (which walks
 * from a schema down to its descendants): this walks up from `schema` via
 * `extends` instead, to check whether it eventually reaches `ancestorName`.
 */
function isSchemaOrDescendant(schema: NormalizedSchema, ancestorName: string, resolvers: Resolvers): boolean {
  let current: NormalizedSchema | undefined = schema;
  while (current) {
    if (current.name === ancestorName) return true;
    current = current.extends ? resolvers.schemas.get(current.extends) : undefined;
  }
  return false;
}

/**
 * Resolves a property name against the *virtual* (inverse) properties a
 * schema exposes, per packages/core/docs/spec/meta-model.md#relations: a relation
 * declared with `inverse_name` on some other schema creates a property of
 * that name on this schema's own instances — already readable (computed on
 * demand by resolveVirtualProperties, never stored) and, from here, settable
 * too. Scans every schema for a relation property that
 * names `name` as its `inverse_name` and targets `schema` or an ancestor of
 * it — e.g. `document.parts` declares `type: document_part`, and has to be
 * found this way for a `document_part_requirement` instance too, not only
 * for a `document_part` created directly — the mirror image of
 * `findProperty`, which only ever sees a schema's own declared properties.
 */
function findInverseProperty(resolvers: Resolvers, schema: NormalizedSchema, name: string): InverseProperty | undefined {
  for (const candidate of resolvers.schemas.values()) {
    for (const prop of candidate.properties) {
      if (
        typeof prop.constraints.inverse_name === "string" &&
        generatedInverseName(candidate.name, prop) === name &&
        isSchemaOrDescendant(schema, prop.type, resolvers)
      ) {
        return { sourceSchema: candidate, sourceProp: prop };
      }
    }
  }
  return undefined;
}

/**
 * Applies a change to a virtual (inverse) property by delegating to the
 * *declaring* side of the relation — e.g. setting wand.bearer really means
 * updating the wizard whose `wand` should now point here. Diffs the key sets
 * the same way propagateInverseChange does, then re-runs the full update
 * path (via runUpdateOne, which calls runCommand) for every source instance
 * gained or lost, so existing validation (mandatory, constant, ownership...)
 * and existing propagation apply for free instead of being duplicated here.
 * `acc` is the *caller's* accumulator (see runUpdateOne) — e.g. clearing an
 * owner's virtual list this way can cascade-delete an owned instance several
 * calls down, and that needs to surface in the original command's own
 * `cascade-deleted`, not just the recursive call's own, otherwise-discarded,
 * result.
 */
async function applyVirtualPropertyChange(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  targetKey: Key,
  inv: InverseProperty,
  oldValue: TransientValue,
  newValue: TransientValue,
  acc: Accumulator,
): Promise<void> {
  const oldKeys = toKeyArray(oldValue);
  const newKeys = toKeyArray(newValue);
  const removed = oldKeys.filter((k) => !newKeys.includes(k));
  const added = newKeys.filter((k) => !oldKeys.includes(k));

  for (const sourceKey of removed) {
    await runUpdateOne(impl, rest, resolvers, inv.sourceSchema, sourceKey, inv.sourceProp, targetKey, false, acc);
  }
  for (const sourceKey of added) {
    await runUpdateOne(impl, rest, resolvers, inv.sourceSchema, sourceKey, inv.sourceProp, targetKey, true, acc);
  }
}

/**
 * Sets (add=true) or clears (add=false) `targetKey` on one source instance's
 * declared relation property, by recursively running an ordinary `update`
 * command against it — this is what makes mandatory/constant/ownership
 * validation and bidirectional propagation apply to a virtual-property write
 * without reimplementing them here. A mandatory violation (e.g. clearing an
 * edge's predecessor without reassigning it) throws out of this call exactly
 * as it would from a direct update against the declaring side; losing an
 * owner this way instead cascade-deletes (see validateInstance/runCommand's
 * `update` case) — merged into `acc` here so it's visible to whichever
 * command originally triggered this delegation, however many calls up.
 */
async function runUpdateOne(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  sourceSchema: NormalizedSchema,
  sourceKey: Key,
  sourceProp: NormalizedProperty,
  targetKey: Key,
  add: boolean,
  acc: Accumulator,
): Promise<void> {
  const sourceKeyProp = keyPropertyName(sourceSchema);
  if (!sourceKeyProp) return; // embedded source schema — no instance to address by key

  const isArray = sourceProp.constraints.is_array === true;
  let newValue: TransientValue;
  if (isArray) {
    // sourceSchema is the schema that *declares* sourceProp (e.g. `document`
    // for `sections`), which the actual stored instance may be a more
    // specific descendant of (e.g. `document_guide`) — findInstanceByKey
    // finds it under whichever schema it's really stored as, the same way
    // the `query`/`update`/`delete` matcher above does; a bare
    // getInstance(sourceSchema.name, ...) would silently miss it and read
    // back an empty array, discarding whatever the property already held.
    const found = await findInstanceByKey(impl, rest, resolvers, sourceSchema, sourceKey);
    const currentKeys = toKeyArray(found?.instance[sourceProp.name]);
    newValue = add ? [...currentKeys.filter((k) => k !== targetKey), targetKey] : currentKeys.filter((k) => k !== targetKey);
  } else {
    newValue = add ? targetKey : null;
  }

  const result = await runCommand(
    impl,
    rest,
    { kind: "update", schema: sourceSchema.name, filters: { [sourceKeyProp]: sourceKey }, input: [{ [sourceProp.name]: newValue }] },
    resolvers,
  );
  acc.cascadeDeleted.push(...result["cascade-deleted"]);
  acc.updatedBefore.push(...result["updated-before"]);
  acc.updatedAfter.push(...result["updated-after"]);
}

/**
 * Every schema whose instances a command targeting `schema` should match:
 * `schema` itself, plus every schema extending it, directly or through
 * further extension — per packages/core/docs/spec/meta-model.md#schema's `extends`
 * ("A command's `schema` matches instances of that schema and,
 * transitively, instances of every schema extending it") and
 * packages/core/docs/spec/model-command-language.md#command's Processing step 4. Walks each
 * candidate's own `extends` chain up to the root rather than walking
 * `schema`'s descendants down, since NormalizedSchema only carries the
 * parent link (`extends`), not a materialized list of children.
 */
function collectExtendingSchemas(schema: NormalizedSchema, resolvers: Resolvers): NormalizedSchema[] {
  const result: NormalizedSchema[] = [schema];
  for (const candidate of resolvers.schemas.values()) {
    if (candidate.name === schema.name) continue;
    let current: string | null = candidate.extends;
    while (current) {
      if (current === schema.name) {
        result.push(candidate);
        break;
      }
      const parent: NormalizedSchema | undefined = resolvers.schemas.get(current);
      current = parent ? parent.extends : null;
    }
  }
  return result;
}

/**
 * Validates that every relation property on `instance` whose value is set
 * resolves, by key, to an instance of that relation's declared schema or a
 * schema extending it (transitively) — see packages/core/docs/spec/meta-model.md#relations.
 * Nothing else checks this: computePropertyValue stores a
 * relation's value as an opaque key with no lookup at all, so without this
 * check a relation could point at a nonexistent key or at an instance of a
 * completely unrelated schema and nothing would notice. One exception,
 * `unknown_relation_target`, covers both cases — a dangling key and a
 * wrong-schema key look identical from here (searching every accepted
 * schema's own instances for the key and finding it nowhere), the same way
 * `unknown_schema`/`unknown_property` don't split into finer sub-cases
 * elsewhere in this file. Reuses collectExtendingSchemas so "the right
 * schema" means the same thing here as it does for query/update/delete
 * matching — an instance of an extending schema is an acceptable target for
 * a relation typed to the schema it extends.
 *
 * Runs over every relation property, not just ones touched by this write
 * (mirrors validateInstance, which likewise re-checks the whole instance
 * rather than only the patched properties) — simpler than tracking which
 * properties changed, and cheap enough for this tool's expected dataset
 * sizes (see resolvers.ts's loadResolvers on the same tradeoff).
 */
async function validateRelationTargets(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  schema: NormalizedSchema,
  instance: TransientObject,
): Promise<void> {
  for (const prop of schema.properties) {
    const resolved = resolveType(prop.type, resolvers.ctx);
    if (resolved.kind !== "relation") continue;

    const isArray = prop.constraints.is_array === true;
    const value = instance[prop.name];
    const keys = isArray
      ? Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : []
      : typeof value === "string"
        ? [value]
        : [];
    if (keys.length === 0) continue;

    const candidates = collectExtendingSchemas(resolved.schema, resolvers);
    for (const key of keys) {
      let found = false;
      for (const candidate of candidates) {
        if (await impl.getInstance(rest, candidate.name, key, derivePropertyRoles(candidate))) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw modelError(
          "unknown_relation_target",
          `"${prop.name}" on "${schema.name}" references "${key}", which is not the key of an instance of "${resolved.schema.name}" or a schema extending it`,
        );
      }
    }
  }
}

/**
 * Runs `command` and shapes what it returns. Every caller — runCommand/
 * runScript/createScriptSession, see api.ts and script.ts — comes through
 * here, so `result` applies uniformly, including to a model command handed
 * on to runSchemaCommand.
 */
export async function runCommand(
  impl: PersistenceInterface,
  rest: string,
  command: Command,
  resolvers: Resolvers,
): Promise<CommandResult> {
  const schema = resolvers.schemas.get(command.schema);
  if (!schema) throw modelError("unknown_schema", `unknown schema "${command.schema}"`);
  if (isFacet(schema)) {
    throw modelError("facet_not_addressable", `"${command.schema}" is a facet — its values are reached through "${String(schema.constraints.facet_of)}"`);
  }
  // `input` is typed as an array (types.ts), but nothing enforced that at the
  // MCP boundary or here — a caller passing a bare object reached create's
  // for-of or update's indexing and failed in kind-specific, sometimes
  // untyped ways (see script.ts's own guard on the same shape). One check at
  // this single choke point gives every kind and every caller the same
  // typed error instead — and, since a bare object is an unambiguous
  // shorthand for a one-element array (packages/core/docs/spec/model-command-language.md#examples's
  // "A single instance shorthand"), wraps it rather than rejecting it.
  // Anything else that isn't an array is still malformed: there's no
  // sensible single-instance reading of a string, a number, or `null`.
  if (command.kind !== "query" && command.input !== undefined && !Array.isArray(command.input)) {
    if (typeof command.input === "object" && command.input !== null) {
      command = { ...command, input: [command.input as unknown as TransientValue] };
    } else {
      throw modelError(
        "constraint_violation",
        `${command.kind} input must be an array of objects, one per instance — wrap a single instance in [ ]`,
      );
    }
  }
  // the namespaces of the facets and of the virtual relations of other modules are nested mappings in an input
  const descendants = collectExtendingSchemas(schema, resolvers);
  if (command.kind !== "query" && Array.isArray(command.input) && descendants.some((s) => qualifiedNamespacesOf(s).length > 0)) {
    command = { ...command, input: command.input.map((item) => flattenInput(item, descendants)) };
  }
  const result = await executeCommand(impl, rest, command, resolvers, schema);
  return nestResult(shapeResult(result, schema, command.result, command.kind));
}

/**
 * An input entry with its namespaces flattened (see `flattenQualified`),
 * against the first of `schemas` (the command's schema, then those extending
 * it) that has every qualified name it gives, so an update reaching a
 * descendant can name what only the descendant carries.
 */
function flattenInput(item: TransientValue, schemas: NormalizedSchema[]): TransientValue {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
  let firstError: unknown;
  for (const candidate of schemas) {
    try {
      return flattenQualified(candidate, item as TransientObject);
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError;
}

/** `result` with the qualified properties of every instance nested by namespace, as a command returns them. */
function nestResult(result: CommandResult): CommandResult {
  return {
    before: result.before.map(nestQualified),
    after: result.after.map(nestQualified),
    "cascade-deleted": result["cascade-deleted"].map(nestQualified),
    "updated-before": result["updated-before"].map(nestQualified),
    "updated-after": result["updated-after"].map(nestQualified),
  };
}

async function executeCommand(
  impl: PersistenceInterface,
  rest: string,
  command: Command,
  resolvers: Resolvers,
  schema: NormalizedSchema,
): Promise<CommandResult> {
  // Handle dataset singleton commands first
  if (command.schema === "dataset") {
    return executeDatasetCommand(impl, rest, command, resolvers, schema);
  }

  // A `schema`/`scalar_type` change is created or changed through
  // runCommand/runScript "exactly like any other instance", per
  // `docs/model-upgrade.md` —
  // but only ever against an upgrade locator; an ordinary locator
  // can only *read* the model (kind: query). Conversely an upgrade locator
  // never holds real data, only a copy of the model — a non-query command
  // against any other schema is rejected there. This single choke point
  // (every one of runCommand/runScript/createScriptSession funnels through
  // runCommand, and so through here, see script.ts) is what makes the gating
  // apply uniformly.
  if (command.kind !== "query") {
    const marker = await getUpgradeMarker(impl, rest);
    if (isModelSchema(command.schema)) {
      if (!marker) {
        throw modelError("not_upgrade_locator", `"${command.schema}" can only be changed against an upgrade locator, see createUpgradeLocator`);
      }
      return runSchemaCommand(impl, rest, command, resolvers);
    }
    if (marker) {
      throw modelError("upgrade_locator", `an upgrade locator holds a copy of the model only — "${command.schema}" is a data schema`);
    }
  }

  // `import` is constant: only the import API creates, refreshes or removes one.
  if (command.schema === "import" && command.kind !== "query") {
    if (command.kind === "create") {
      throw modelError("import_cannot_be_created", `an import is created by createImport, never by a command`);
    }
    throw modelError("constraint_violation", `an import is constant: ${command.kind} it with refreshImport or removeImport`);
  }
  const namespace = command.namespace ?? "";
  if (typeof namespace !== "string") throw modelError("constraint_violation", `the namespace of a command is a string`);
  if (namespace !== "") {
    if (command.kind !== "query") {
      throw modelError("constraint_violation", `imported instances are read-only: a ${command.kind} reaches the dataset's own instances only, with no namespace`);
    }
    if (namespace !== "*" && !(resolvers.importNamespaces ?? []).includes(namespace)) {
      throw modelError("constraint_violation", `"${namespace}" is the namespace of no import of the dataset`);
    }
  }
  const inNamespace = (key: Key): boolean => {
    if (namespace === "*") return true;
    const of = importNamespaceOf(key, (resolvers.importNamespaces ?? []));
    return namespace === "" ? of === undefined : of === namespace;
  };

  const datasetValue = await impl.getDataset(rest);
  // command.kind !== "query" already ruled out isModelSchema(command.schema)
  // above (delegated to runSchemaCommand instead) — schema is always an
  // ordinary data schema by the time execution reaches here, so its roles
  // apply to every instance-storage call below.
  const roles = derivePropertyRoles(schema);
  // One live-join cache per command execution — see LiveJoinCache. Shared by
  // every branch below (query match loop, create, update, delete), never by
  // a recursive runCommand call (e.g. via runUpdateOne), which gets its own
  // fresh executeCommand call and so its own fresh cache.
  const cache: LiveJoinCache = new Map();

  let matched: { key: Key; instance: TransientValue; schema: NormalizedSchema }[] = [];
  if (command.kind !== "create") {
    const filterCtx = { ...resolvers.ctx, impl, rest };
    // `schema` plus every schema (transitively) extending it — each listed
    // and filtered against its own (flattened) properties, since a
    // descendant schema may declare properties the base schema doesn't have.
    const candidateSchemas = collectExtendingSchemas(schema, resolvers);
    // Checked on the schemas alone, before the first instance is read — per
    // the filter spec's *Shape* and *Arrays as values*.
    checkFilterOnCandidates(command.filters, candidateSchemas, resolvers.ctx);
    for (const candidateSchema of candidateSchemas) {
      const candidateRoles = derivePropertyRoles(candidateSchema);
      const byKey = new Map<Key, TransientValue>();
      for (const raw of await impl.listInstances(rest, candidateSchema.name, candidateRoles)) {
        byKey.set(keyOf(candidateSchema, raw), raw);
      }
      for (const [rawKey, raw] of byKey) {
        if (!inNamespace(rawKey)) continue;
        // Every virtual (generated) relation property is resolved before
        // filtering and before it's returned — per packages/core/docs/spec/meta-model.md#relations,
        // "every time a virtual relation is read, whether as a
        // returned property or as the left-hand side of a filter."
        const instance = await resolveVirtualProperties(impl, rest, resolvers, candidateSchema, clone(raw) as TransientObject, cache);
        if (await matchFilter(instance, command.filters, candidateSchema, filterCtx)) {
          matched.push({ key: keyOf(candidateSchema, instance), instance, schema: candidateSchema });
        }
      }
    }
  }

  switch (command.kind) {
    case "query": {
      return {
        before: matched.map((m) => clone(m.instance)),
        after: matched.map((m) => clone(m.instance)),
        "cascade-deleted": [],
        "updated-before": [],
        "updated-after": [],
      };
    }

    case "create": {
      const acc: Accumulator = { updatedBefore: [], updatedAfter: [], cascadeDeleted: [] };
      const after: TransientValue[] = [];
      for (const item of command.input ?? []) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw modelError("constraint_violation", "create input entries must be objects");
        }
        const itemObj = item as TransientObject;
        // Resolve every property's type once, then compute relations before
        // scalars: a scalar's default_value placeholder (e.g. an is_folder
        // property deriving its path from `${this.owning_document}`) may
        // reference a sibling relation, and a relation's own value never
        // depends on a scalar (see computePropertyValue — the relation
        // branch never touches default_value/placeholders), so resolving
        // every relation first is always safe. `computed` accumulates
        // values in this dependency-safe order; `instance` is rebuilt below
        // in schema-declared order, so downstream consumers that rely on
        // property order (e.g. a persistent format's frontmatter field
        // order) see no change.
        const withResolved = schema.properties.map((prop) => ({ prop, resolved: resolveType(prop.type, resolvers.ctx) }));
        const computed: TransientObject = {};
        // a value of a facet given no value, or null, stays unset
        const unsetFacet = (prop: NormalizedProperty) =>
          facetOfProperty(prop) !== undefined && (itemObj[prop.name] === undefined || itemObj[prop.name] === null);
        // a default whose placeholder crosses a relation reads the related instance first
        const effective = async (prop: NormalizedProperty, hasProvided: boolean): Promise<NormalizedProperty> =>
          !hasProvided && mayCrossRelations(prop)
            ? { ...prop, default_value: await crossRelations(impl, rest, resolvers, schema, prop, computed) }
            : prop;
        for (const { prop, resolved } of withResolved) {
          if (resolved.kind !== "relation" || unsetFacet(prop)) continue;
          const hasProvided = Object.prototype.hasOwnProperty.call(itemObj, prop.name);
          computed[prop.name] = computePropertyValue(
            await effective(prop, hasProvided),
            hasProvided,
            hasProvided ? itemObj[prop.name] : undefined,
            resolved,
            computed,
            schema,
            datasetValue,
          );
        }
        for (const { prop, resolved } of withResolved) {
          if (resolved.kind === "relation" || unsetFacet(prop)) continue;
          const hasProvided = Object.prototype.hasOwnProperty.call(itemObj, prop.name);
          computed[prop.name] = computePropertyValue(
            await effective(prop, hasProvided),
            hasProvided,
            hasProvided ? itemObj[prop.name] : undefined,
            resolved,
            computed,
            schema,
            datasetValue,
          );
        }
        const instance: TransientObject = {};
        for (const prop of schema.properties) {
          if (facetOfProperty(prop) !== undefined && computed[prop.name] === undefined) continue;
          instance[prop.name] = computed[prop.name];
        }

        let key: Key;
        if (isSharedByName(schema)) {
          if (typeof instance.name !== "string" || !instance.name) {
            throw modelError("constraint_violation", `schema "${schema.name}" requires "name" to create an instance`);
          }
          if (Object.prototype.hasOwnProperty.call(itemObj, "id") && itemObj.id !== undefined && itemObj.id !== null) {
            throw modelError("constraint_violation", `schema "${schema.name}" is shared_by_name and takes no "id"`);
          }
          key = instance.name;
        } else {
          key = await resolveCreateId(impl, rest, schema.name, itemObj, roles);
          instance.id = key;
        }

        // `singleton`: the schema holds at most one instance in the dataset,
        // so a second one is refused before it is stored.
        if (schema.constraints.singleton === true && (await impl.listInstances(rest, schema.name, roles)).length > 0) {
          throw modelError("constraint_violation", `schema "${schema.name}" is a singleton and already has an instance`);
        }
        await validateRelationTargets(impl, rest, resolvers, schema, instance);
        validateInstance(schema, instance, resolvers, { isUpdate: false });
        // Per packages/core/docs/spec/meta-model.md#relations, a virtual relation is
        // never stored — stripped before this instance ever reaches
        // putInstance's `instance` argument.
        await impl.putInstance(rest, schema.name, key, withoutVirtualRelations(schema, instance), roles);
        // the first value set creates the instance of a facet
        const facetValues: TransientObject = {};
        for (const prop of schema.properties) {
          if (facetOfProperty(prop) !== undefined && instance[prop.name] !== undefined) facetValues[prop.name] = instance[prop.name];
        }
        await writeFacetValues(impl, rest, resolvers.ctx, schema, key, facetValues);

        for (const prop of schema.properties) {
          if (typeof prop.constraints.inverse_name === "string") {
            const isArray = prop.constraints.is_array === true;
            await propagateInverseChange(impl, rest, resolvers, schema, key, prop, isArray ? [] : null, instance[prop.name], acc, cache);
          }
        }

        // The loop above walks this schema's own declared relations, so a
        // *generated* (inverse) property given a value at creation is only
        // reflected in `instance`'s own in-memory value — the declaring
        // instance's own relation never gains this key. Per
        // packages/core/docs/spec/meta-model.md#relations a virtual relation is an
        // ordinary relation to write through, so creation delegates to the
        // declaring side the same way `update` does below, after this
        // instance's own write so the declaring side finds it already in
        // storage.
        const virtualWrites = schema.properties.filter(
          (prop) => prop.constraints.__generated === true && !isUnsetRelation(instance[prop.name]),
        );
        for (const prop of virtualWrites) {
          const inv = findInverseProperty(resolvers, schema, prop.name);
          if (!inv) continue;
          const emptyValue = prop.constraints.is_array === true ? [] : null;
          await applyVirtualPropertyChange(impl, rest, resolvers, key, inv, emptyValue, instance[prop.name], acc);
        }
        // No generated relation is ever stored, so the created instance's
        // returned value is always computed via a fresh live join, whether
        // or not this creation itself provided any virtual property.
        const created = await resolveVirtualProperties(impl, rest, resolvers, schema, clone(instance) as TransientObject, cache);
        after.push(clone(created));
      }
      return {
        before: [],
        after,
        "cascade-deleted": [],
        "updated-before": acc.updatedBefore,
        "updated-after": acc.updatedAfter,
      };
    }

    case "update": {
      const inputs = command.input ?? [];
      if (inputs.length === 0) throw modelError("empty_input", `update on "${schema.name}" requires input`);
      const acc: Accumulator = { updatedBefore: [], updatedAfter: [], cascadeDeleted: [] };
      const before: TransientValue[] = [];
      const after: TransientValue[] = [];

      for (let i = 0; i < matched.length; i++) {
        const patch = inputs[i % inputs.length];
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
          throw modelError("constraint_violation", "update input entries must be objects");
        }
        // A matched instance may belong to `schema` itself or to any schema
        // extending it (see collectExtendingSchemas above) — every property
        // lookup, validation and storage call below must use that instance's
        // own (flattened) schema, not the command's `schema`, since a
        // descendant schema may declare properties/constraints the base
        // schema doesn't have.
        const { key, instance, schema: instSchema } = matched[i];
        const instRoles = derivePropertyRoles(instSchema);
        const instKeyProp = keyPropertyName(instSchema);
        before.push(clone(instance));
        const updated: TransientObject = { ...(instance as TransientObject) };
        const relationChanges: { prop: NormalizedProperty; oldValue: TransientValue }[] = [];
        const virtualChanges: { inv: InverseProperty; oldValue: TransientValue; newValue: TransientValue }[] = [];
        // the values of facets the patch names: a patch changes only those, and null unsets one
        const facetChanges: TransientObject = {};

        for (const [propName, rawValue] of Object.entries(patch as TransientObject)) {
          if (propName === instKeyProp) {
            throw modelError("constraint_violation", `"${propName}" is the key of "${instSchema.name}" and cannot be updated`);
          }
          const prop = findProperty(instSchema, propName);
          // A property that either isn't declared at all, or is one Schema
          // Processing auto-generated for an inverse relation (`__generated`
          // — see modelUpgrade.ts's applyInverseRelations, which materializes
          // the *other* side's `inverse_name` as a real declared property so
          // it's readable and filterable) is never written directly here.
          // Per packages/core/docs/spec/meta-model.md#relations — "The virtual relation
          // can be used in the modelling language as a regular relation" — a
          // write to it is delegated to the declaring side below instead.
          if (!prop || prop.constraints.__generated === true) {
            const inv = findInverseProperty(resolvers, instSchema, propName);
            if (inv) {
              virtualChanges.push({ inv, oldValue: (instance as TransientObject)[propName] ?? null, newValue: (rawValue ?? null) as TransientValue });
            }
            // else: truly unrecognized key, or a generated property somehow
            // missing its declaring side — silently ignored, see core README.
            continue;
          }
          if (prop.constraints.constant === true) {
            throw modelError("constraint_violation", `"${propName}" is constant on "${instSchema.name}"`);
          }
          if (facetOfProperty(prop) !== undefined && (rawValue === null || rawValue === undefined)) {
            delete updated[propName];
            facetChanges[propName] = null;
            continue;
          }
          const resolved = resolveType(prop.type, resolvers.ctx);
          if (resolved.kind === "relation" && typeof prop.constraints.inverse_name === "string") {
            relationChanges.push({ prop, oldValue: (instance as TransientObject)[propName] ?? null });
          }
          // A mapping is a text operation (the part `command`, "Text
          // operations"): resolved here against this instance's current
          // value, so what reaches computePropertyValue, validateInstance
          // and putInstance is an ordinary string value.
          const providedValue = isPlainObject(rawValue)
            ? resolvePatchMapping(prop, resolved, instSchema.name, (instance as TransientObject)[propName], rawValue)
            : rawValue;
          updated[propName] = computePropertyValue(prop, true, providedValue, resolved, updated, instSchema, datasetValue);
          if (prop.constraints.set_once === true) {
            // set at most once: from no value to a value; the same value again changes nothing
            const current = (instance as TransientObject)[propName];
            const next = updated[propName];
            if (JSON.stringify(current ?? null) !== JSON.stringify(next ?? null) && !isNoValue(current, resolved)) {
              throw modelError("constraint_violation", `"${propName}" is set_once on "${instSchema.name}" and already holds ${JSON.stringify(current)}`);
            }
          }
          if (facetOfProperty(prop) !== undefined) facetChanges[propName] = updated[propName];
        }

        await validateRelationTargets(impl, rest, resolvers, instSchema, updated);
        const losesOwner = validateInstance(instSchema, updated, resolvers, { isUpdate: true });
        if (losesOwner) {
          // Per packages/core/docs/spec/meta-model.md#ownership: "When an instance is
          // updated if it loses its owner it is automatically deleted." Never
          // written as `updated` (still holding a null owner) — deleted
          // outright instead. performDelete re-reads the instance from
          // storage, which still has its *old* (pre-patch) data, since
          // nothing above has written `updated` yet — exactly what's wanted:
          // its own inverse-relation cleanup (detaching from whichever owner
          // it's still actually pointing at) and any further cascade (things
          // this instance itself owns) both run against real, current data.
          // No `after` entry — matches the "delete" case, which doesn't
          // populate `after` either, and for the same reason: the instance
          // no longer exists to report.
          await assertDeletable(impl, rest, resolvers, [{ schema: instSchema, key }]);
          await performDelete(impl, rest, resolvers, instSchema, key, acc, true, cache);
          continue;
        }
        // Per packages/core/docs/spec/meta-model.md#relations, a virtual relation is
        // never stored — stripped before this instance ever reaches
        // putInstance's `instance` argument.
        await impl.putInstance(rest, instSchema.name, key, withoutVirtualRelations(instSchema, updated), instRoles);
        await writeFacetValues(impl, rest, resolvers.ctx, instSchema, key, facetChanges);

        for (const { prop, oldValue } of relationChanges) {
          await propagateInverseChange(impl, rest, resolvers, instSchema, key, prop, oldValue, updated[prop.name], acc, cache);
        }

        // Delegated after this instance's own write: each virtual change
        // recursively updates the *other* schema (runUpdateOne). No
        // generated relation is ever stored, so — whether or not this patch
        // touched one — `after` is always computed via a fresh live join
        // rather than a re-read from storage.
        for (const { inv, oldValue, newValue } of virtualChanges) {
          await applyVirtualPropertyChange(impl, rest, resolvers, key, inv, oldValue, newValue, acc);
        }
        const resolvedAfter = await resolveVirtualProperties(impl, rest, resolvers, instSchema, clone(updated) as TransientObject, cache);
        after.push(clone(resolvedAfter));
      }

      return {
        before,
        after,
        "cascade-deleted": acc.cascadeDeleted,
        "updated-before": acc.updatedBefore,
        "updated-after": acc.updatedAfter,
      };
    }

    case "delete": {
      const cascade = command.cascade === true;
      const acc: Accumulator = { updatedBefore: [], updatedAfter: [], cascadeDeleted: [], cascade };
      const before = matched.map((m) => clone(m.instance));
      // refused as a whole, before anything is written, when an instance that stays restricts it, or goes with it without consent
      await assertDeletable(impl, rest, resolvers, matched.map((m) => ({ schema: m.schema, key: m.key })), cascade);
      for (const m of matched) {
        // Delete against the matched instance's own schema — it may be
        // `schema` itself or one extending it (see collectExtendingSchemas).
        await performDelete(impl, rest, resolvers, m.schema, m.key, acc, false, cache);
      }
      return {
        before,
        after: [],
        "cascade-deleted": acc.cascadeDeleted,
        "updated-before": acc.updatedBefore,
        "updated-after": acc.updatedAfter,
      };
    }

    default:
      throw modelError("constraint_violation", `unknown command kind "${(command as Command).kind}"`);
  }
}

/**
 * Builds the dataset's transient form: scalar fields from getDataset plus
 * schemas/scalar_types as arrays of names.
 * Same logic as api.ts's datasetTransientForm, kept here to avoid circular
 * imports between command.ts and api.ts.
 */
async function buildDatasetTransientForm(impl: PersistenceInterface, rest: string): Promise<TransientObject> {
  const info = (await impl.getDataset(rest)) as TransientObject;
  const [schemas, scalarTypes] = await Promise.all([
    impl.listInstances(rest, "schema", SCHEMA_ROLES),
    impl.listInstances(rest, "scalar_type", NO_ROLES),
  ]);
  const names = (instances: TransientValue[]) => instances.map((i) => (i as TransientObject).name);
  return {
    ...info,
    schemas: names(schemas),
    scalar_types: names(scalarTypes),
    modules: Array.isArray(info.modules) ? info.modules : [],
    imports: (await impl.listInstances(rest, "import", NO_ROLES)).map((i) => (i as TransientObject).name),
  };
}

/**
 * Handles commands targeting the `dataset` singleton schema:
 * - query: returns the dataset's transient form (same as queryDataset)
 * - update: renames the dataset (only `name` is writable)
 * - create/delete: refused with constraint_violation
 */
async function executeDatasetCommand(
  impl: PersistenceInterface,
  rest: string,
  command: Command,
  resolvers: Resolvers,
  schema: NormalizedSchema,
): Promise<CommandResult> {
  const READ_ONLY_PROPERTIES = [
    "model_major_version",
    "model_minor_version",
    "data_major_version",
    "data_minor_version",
    "created_at",
    "updated_at",
    "model_only",
    "schemas",
    "scalar_types",
    "modules",
    "imports",
  ];

  switch (command.kind) {
    case "query": {
      const dataset = await buildDatasetTransientForm(impl, rest);

      // Apply filters if present
      if (command.filters) {
        const filterCtx = { ...resolvers.ctx, impl, rest };
        checkFilter(command.filters, schema, resolvers.ctx);
        const matches = await matchFilter(dataset, command.filters, schema, filterCtx);
        if (!matches) {
          return emptyResult();
        }
      }

      return {
        before: [clone(dataset)],
        after: [clone(dataset)],
        "cascade-deleted": [],
        "updated-before": [],
        "updated-after": [],
      };
    }

    case "update": {
      const inputs = command.input ?? [];
      if (inputs.length === 0) throw modelError("empty_input", `update on "dataset" requires input`);
      const patch = inputs[0];
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw modelError("constraint_violation", "update input entries must be objects");
      }

      const patchObj = patch as TransientObject;
      
      // Check for read-only properties
      for (const prop of READ_ONLY_PROPERTIES) {
        if (Object.prototype.hasOwnProperty.call(patchObj, prop)) {
          throw modelError("constraint_violation", `"${prop}" is read-only on "dataset" and cannot be updated`);
        }
      }

      const before = await buildDatasetTransientForm(impl, rest);

      // Apply filters if present
      if (command.filters) {
        const filterCtx = { ...resolvers.ctx, impl, rest };
        checkFilter(command.filters, schema, resolvers.ctx);
        const matches = await matchFilter(before, command.filters, schema, filterCtx);
        if (!matches) {
          return emptyResult();
        }
      }

      // `name` and `languages` are the writable properties
      const hasName = Object.prototype.hasOwnProperty.call(patchObj, "name");
      const hasLanguages = Object.prototype.hasOwnProperty.call(patchObj, "languages");
      if (hasName || hasLanguages) {
        const datasetPatch: TransientObject = {};
        if (hasName) {
          const newName = patchObj.name;
          if (typeof newName !== "string") {
            throw modelError("constraint_violation", `"name" must be a string`);
          }

          // Validate against identifier scalar type unconditionally
          const resolved = resolveType("identifier", resolvers.ctx);
          if (resolved.kind === "scalar") {
            validateScalarValue("name", resolved.base, newName, { ...resolved.constraints });
          }
          datasetPatch.name = newName;
        }
        if (hasLanguages) datasetPatch.languages = validateLanguages(patchObj.languages);

        // Only patch what was given - version bumping is handled by the generic layer
        await impl.updateDataset(rest, datasetPatch);

        const after = await buildDatasetTransientForm(impl, rest);

        return {
          before: [clone(before)],
          after: [clone(after)],
          "cascade-deleted": [],
          "updated-before": [],
          "updated-after": [],
        };
      }

      // No writable properties were changed
      return {
        before: [clone(before)],
        after: [clone(before)],
        "cascade-deleted": [],
        "updated-before": [],
        "updated-after": [],
      };
    }

    case "create":
      throw modelError("constraint_violation", `"dataset" is a singleton and cannot be created via command — use initDataset or restoreDataset`);

    case "delete":
      throw modelError("constraint_violation", `"dataset" is a singleton and cannot be deleted via command — use deleteDataset`);

    default:
      throw modelError("constraint_violation", `unknown command kind "${(command as Command).kind}"`);
  }
}

export { emptyResult, keyOf, clone, coerceScalar, validateScalarValue, assertDistinct, requiresDistinct, validateMapValue, computePropertyValue, collectExtendingSchemas, resolveVirtualProperties, isSchemaOrDescendant };
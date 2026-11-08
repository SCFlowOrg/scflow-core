import { modelError } from "./errors.js";
import { parseMapType } from "./mapTypes.js";
import type { Filter, NormalizedProperty, TransientObject, TransientValue } from "./types.js";

/**
 * The declarations of the rules of a schema, per
 * packages/core/docs/spec/meta-model.md#rules, as schema processing reads them
 * (model-command-language.md#schema-processing, *Rules*): the shapes that one
 * schema decides alone. What needs the whole model (paths, the schema of an
 * `exists`, the target of `acyclic`) is checked by `validateRules` in
 * `rules.ts`, once every schema is known.
 */

/** An entry of `checks`: a condition on one instance, `require`, or an instance that must exist, `exists`. */
export interface CheckRule {
  name: string;
  /** The instances the rule applies to; every instance when absent. */
  when?: Filter;
  require?: Filter;
  exists?: { schema: string; with: TransientObject };
  /** With `exists` only: values tested in turn under the name `each`, a list or one placeholder giving one. */
  each?: TransientValue;
}

/** A group of `unique`: no two instances share the values of its properties. */
export interface UniqueGroup {
  name: string;
  properties: string[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHECK_KEYS = new Set(["name", "when", "require", "exists", "each"]);

function isMapping(value: unknown): value is TransientObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(schemaName: string, message: string): never {
  throw modelError("constraint_violation", `schema "${schemaName}": ${message}`);
}

/** The `checks` of a schema's constraints, as stored. */
export function checksOf(constraints: Record<string, TransientValue>): CheckRule[] {
  return Array.isArray(constraints.checks) ? (constraints.checks as unknown as CheckRule[]) : [];
}

/** The `unique` groups of a schema's constraints, as stored. */
export function uniqueGroupsOf(constraints: Record<string, TransientValue>): UniqueGroup[] {
  return Array.isArray(constraints.unique) ? (constraints.unique as unknown as UniqueGroup[]) : [];
}

function readCheck(schemaName: string, raw: TransientValue, i: number): CheckRule {
  if (!isMapping(raw)) fail(schemaName, `checks[${i}] must be a mapping`);
  const extra = Object.keys(raw).filter((k) => !CHECK_KEYS.has(k));
  if (extra.length > 0) fail(schemaName, `checks[${i}] has ${extra.map((k) => `"${k}"`).join(", ")}, which a check does not take`);
  if (typeof raw.name !== "string" || !IDENTIFIER.test(raw.name)) fail(schemaName, `checks[${i}] needs a "name" that is an identifier`);
  const where = `the check "${raw.name}"`;
  const hasRequire = raw.require !== undefined && raw.require !== null;
  const hasExists = raw.exists !== undefined && raw.exists !== null;
  if (hasRequire === hasExists) fail(schemaName, `${where} has ${hasRequire ? "both" : "neither"} of "require" and "exists"; it takes exactly one`);
  if (raw.each !== undefined && !hasExists) fail(schemaName, `${where} has "each", which goes with "exists" only`);
  if (raw.when !== undefined && !isMapping(raw.when)) fail(schemaName, `the "when" of ${where} must be a filter mapping`);
  if (hasRequire && !isMapping(raw.require)) fail(schemaName, `the "require" of ${where} must be a filter mapping`);
  const check: CheckRule = { name: raw.name };
  if (raw.when !== undefined) check.when = raw.when as Filter;
  if (hasRequire) check.require = raw.require as Filter;
  if (hasExists) {
    const exists = raw.exists;
    if (!isMapping(exists) || typeof exists.schema !== "string" || exists.schema === "") {
      fail(schemaName, `the "exists" of ${where} gives a "schema" and the values of "with"`);
    }
    const extraKeys = Object.keys(exists).filter((k) => k !== "schema" && k !== "with");
    if (extraKeys.length > 0) fail(schemaName, `the "exists" of ${where} takes "schema" and "with" only`);
    if (exists.with !== undefined && !isMapping(exists.with)) fail(schemaName, `the "with" of ${where} must be a mapping of property values`);
    check.exists = { schema: exists.schema, with: (exists.with ?? {}) as TransientObject };
    if (raw.each !== undefined) {
      if (!Array.isArray(raw.each) && typeof raw.each !== "string") fail(schemaName, `the "each" of ${where} is a list, or a placeholder giving one`);
      check.each = raw.each;
    }
  }
  return check;
}

function readUniqueGroup(schemaName: string, raw: TransientValue, i: number, properties: NormalizedProperty[]): UniqueGroup {
  if (!isMapping(raw)) fail(schemaName, `unique[${i}] must be a mapping`);
  const extra = Object.keys(raw).filter((k) => k !== "name" && k !== "properties");
  if (extra.length > 0) fail(schemaName, `unique[${i}] takes "name" and "properties" only`);
  if (typeof raw.name !== "string" || !IDENTIFIER.test(raw.name)) fail(schemaName, `unique[${i}] needs a "name" that is an identifier`);
  const props = raw.properties;
  if (!Array.isArray(props) || props.length === 0 || props.some((p) => typeof p !== "string")) {
    fail(schemaName, `the unique group "${raw.name}" lists its properties by name`);
  }
  for (const name of props as string[]) {
    const prop = properties.find((p) => p.name === name);
    if (!prop) fail(schemaName, `the unique group "${raw.name}" names "${name}", which is not a direct property of the schema`);
    if (prop.constraints.is_array === true || parseMapType(prop.type) !== null || prop.constraints.__generated === true) {
      fail(schemaName, `the unique group "${raw.name}" names "${name}", which is not a scalar nor a single-valued relation`);
    }
  }
  return { name: raw.name, properties: [...(props as string[])] };
}

/**
 * Reads and checks the rule declarations of a schema being processed, and
 * returns its `checks` and `unique` as stored: those of `parent`, then its own,
 * since a schema extending another keeps its rules. A rule name declared twice,
 * a `checks` entry with both or neither of `require` and `exists`, `each`
 * without `exists`, a `unique` group naming something other than a direct
 * scalar or single-valued relation, `set_once` with `constant`, on an array or
 * on a map, and `acyclic` on an array are refused with `constraint_violation`.
 */
export function processRuleDeclarations(
  schemaName: string,
  own: Record<string, TransientValue>,
  parent: Record<string, TransientValue> | undefined,
  properties: NormalizedProperty[],
): { checks?: TransientValue; unique?: TransientValue } {
  if (own.checks !== undefined && !Array.isArray(own.checks)) fail(schemaName, `"checks" is a list of named rules`);
  if (own.unique !== undefined && !Array.isArray(own.unique)) fail(schemaName, `"unique" is a list of named groups`);
  const ownChecks = ((own.checks as TransientValue[] | undefined) ?? []).map((c, i) => readCheck(schemaName, c, i));
  const ownGroups = ((own.unique as TransientValue[] | undefined) ?? []).map((g, i) => readUniqueGroup(schemaName, g, i, properties));
  const checks = [...checksOf(parent ?? {}), ...ownChecks];
  const unique = [...uniqueGroupsOf(parent ?? {}), ...ownGroups];
  const names = new Set<string>();
  for (const rule of [...checks, ...unique]) {
    if (names.has(rule.name)) fail(schemaName, `the rule "${rule.name}" is declared twice`);
    names.add(rule.name);
  }
  for (const prop of properties) {
    if (prop.constraints.set_once === true) {
      if (prop.constraints.constant === true) fail(schemaName, `"${prop.name}" is both set_once and constant`);
      if (prop.constraints.is_array === true || parseMapType(prop.type) !== null) fail(schemaName, `"${prop.name}" is set_once, which an array or a map cannot be`);
    }
    if (prop.constraints.acyclic === true && prop.constraints.is_array === true) {
      fail(schemaName, `"${prop.name}" is acyclic, which only a single-valued relation can be`);
    }
  }
  const out: { checks?: TransientValue; unique?: TransientValue } = {};
  if (checks.length > 0) out.checks = checks as unknown as TransientValue;
  if (unique.length > 0) out.unique = unique as unknown as TransientValue;
  return out;
}

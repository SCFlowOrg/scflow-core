import { modelError } from "./errors.js";
import type { ResolvedType } from "./schemaProcessing.js";
import type { NormalizedProperty, TransientValue } from "./types.js";

/**
 * Text operations of an `update` — the part `command`'s "Text operations" in
 * the `core` dataset. A patch value that is a mapping edits the current value
 * of a single-valued `string` property in place; the value it yields is then
 * an ordinary patch value for the rest of the update.
 */

/** A mapping: neither `null`, nor an array, nor a scalar. */
export function isPlainObject(value: unknown): value is Record<string, TransientValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const REPLACE_KEYS = new Set(["find", "with", "all"]);

/**
 * Resolves the text operation `operation` on the property `prop` of an
 * instance whose current value for it is `current`, and returns the text the
 * patch sets.
 *
 * Throws `constraint_violation` when the property is not a single-valued
 * `string` or an operand is malformed, `unknown_text_operation` when the
 * mapping is not exactly one of `append`/`replace`, and `text_not_found`/
 * `text_not_unique` when a `replace` does not find `find` exactly once
 * (without `all: true`) or at least once (with it).
 */
export function resolveTextOperation(
  prop: NormalizedProperty,
  resolved: ResolvedType,
  schemaName: string,
  current: TransientValue | undefined,
  operation: Record<string, TransientValue>,
): string {
  const where = `"${prop.name}" on "${schemaName}"`;
  if (resolved.kind !== "scalar" || resolved.base !== "string" || prop.constraints.is_array === true) {
    throw modelError("constraint_violation", `a text operation applies to a single-valued string property, and ${where} is not one`);
  }

  const keys = Object.keys(operation);
  if (keys.length !== 1 || (keys[0] !== "append" && keys[0] !== "replace")) {
    throw modelError("unknown_text_operation", `a text operation on ${where} carries exactly one key, "append" or "replace"; got ${keys.length === 0 ? "none" : keys.map((k) => `"${k}"`).join(", ")}`);
  }

  const text = current === null || current === undefined ? "" : String(current);

  if (keys[0] === "append") {
    const operand = operation.append;
    if (typeof operand !== "string") {
      throw modelError("constraint_violation", `"append" on ${where} takes a string`);
    }
    return text + operand;
  }

  const operand = operation.replace;
  if (!isPlainObject(operand)) {
    throw modelError("constraint_violation", `"replace" on ${where} takes a mapping with "find" and "with"`);
  }
  for (const key of Object.keys(operand)) {
    if (!REPLACE_KEYS.has(key)) {
      throw modelError("constraint_violation", `"replace" on ${where} has an unknown key "${key}"; expected "find", "with" and "all"`);
    }
  }
  const { find, with: replacement, all } = operand;
  if (typeof find !== "string" || find === "") {
    throw modelError("constraint_violation", `"replace.find" on ${where} must be a non-empty string`);
  }
  if (typeof replacement !== "string") {
    throw modelError("constraint_violation", `"replace.with" on ${where} must be a string`);
  }
  if (all !== undefined && typeof all !== "boolean") {
    throw modelError("constraint_violation", `"replace.all" on ${where} must be a boolean`);
  }

  // Occurrences are literal, case-sensitive and counted left to right without overlap.
  let count = 0;
  let first = -1;
  for (let from = 0; ; ) {
    const at = text.indexOf(find, from);
    if (at < 0) break;
    if (count === 0) first = at;
    count++;
    from = at + find.length;
  }
  if (count === 0) {
    throw modelError("text_not_found", `"replace" on ${where} finds no occurrence of ${JSON.stringify(find)}`);
  }
  if (all === true) return text.split(find).join(replacement);
  if (count > 1) {
    throw modelError("text_not_unique", `"replace" on ${where} finds ${count} occurrences of ${JSON.stringify(find)}; use "all: true" to replace every one`);
  }
  return text.slice(0, first) + replacement + text.slice(first + find.length);
}

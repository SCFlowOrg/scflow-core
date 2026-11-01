import { modelError } from "./errors.js";

/**
 * Map types — the "Map types" paragraph of the `property` part and the
 * `internationalization` part in the `core` dataset. A property typed
 * `{K: V}` holds a map: unordered entries, each key of the string-based scalar
 * type `K` unique, each value of the scalar type `V`. This module reads the
 * notation; `resolveType` turns it into a resolved map type, and `command.ts`
 * validates and stores the values.
 */

/** The built-in names of two map types, each mapped to the `{K: V}` notation it stands for. */
export const LOCALIZED_MAP_TYPES: ReadonlyMap<string, string> = new Map([
  ["localized_string", "{language_code: string}"],
  ["localized_markdown", "{language_code: markdown}"],
]);

/** The two scalar type names a map type `{K: V}` is made of. */
export interface MapTypeParts {
  key: string;
  value: string;
}

const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads a property `type` as a map type: the `{K: V}` notation, or the name of
 * a built-in map type (`localized_string`, `localized_markdown`). Returns
 * `null` when `typeName` is neither. Throws `constraint_violation` when the
 * notation is malformed: unclosed, without a key or a value, or with a
 * relation, an array or another map as a value or key, none of which a map
 * supports.
 */
export function parseMapType(typeName: string): MapTypeParts | null {
  const notation = LOCALIZED_MAP_TYPES.get(typeName) ?? typeName.trim();
  if (!notation.startsWith("{")) return null;
  if (!notation.endsWith("}")) {
    throw modelError("constraint_violation", `map type "${typeName}" is not closed by "}"`);
  }
  const body = notation.slice(1, -1);
  const colon = body.indexOf(":");
  const key = colon < 0 ? "" : body.slice(0, colon).trim();
  const value = colon < 0 ? "" : body.slice(colon + 1).trim();
  if (!TYPE_NAME.test(key) || !TYPE_NAME.test(value)) {
    throw modelError(
      "constraint_violation",
      `map type "${typeName}" must be written {K: V}, where K and V are each the name of a scalar type — an array or another map is not supported`,
    );
  }
  return { key, value };
}

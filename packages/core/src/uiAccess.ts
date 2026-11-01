import { modelError } from "./errors.js";
import { findProperty, keyPropertyName } from "./schema.js";
import type { NormalizedProperty, NormalizedSchema, TransientValue } from "./types.js";

/** What a user interface may do with a schema or a property: not show it, show it, or show it and let the user change it. */
export type UiAccess = "hidden" | "read_only" | "editable";

/** The levels of `ui_access`, lowest first. */
export const UI_ACCESS_LEVELS: readonly UiAccess[] = ["hidden", "read_only", "editable"];

/** The level of a schema without `ui_access`. */
const DEFAULT_SCHEMA_LEVEL: UiAccess = "read_only";

function isUiAccess(value: unknown): value is UiAccess {
  return typeof value === "string" && (UI_ACCESS_LEVELS as readonly string[]).includes(value);
}

function lowest(...levels: UiAccess[]): UiAccess {
  return levels.reduce((a, b) => (UI_ACCESS_LEVELS.indexOf(b) < UI_ACCESS_LEVELS.indexOf(a) ? b : a));
}

/** Rejects a `ui_access` that is not one of the three levels, on the schema or on any of its properties. */
export function validateUiAccessConstraints(
  schemaName: string,
  properties: NormalizedProperty[],
  schemaConstraints: Record<string, TransientValue>,
): void {
  if ("ui_access" in schemaConstraints && !isUiAccess(schemaConstraints.ui_access)) {
    throw modelError(
      "constraint_violation",
      `schema "${schemaName}" has "ui_access" ${JSON.stringify(schemaConstraints.ui_access)}; expected one of ${UI_ACCESS_LEVELS.join(", ")}`,
    );
  }
  for (const prop of properties) {
    if ("ui_access" in prop.constraints && !isUiAccess(prop.constraints.ui_access)) {
      throw modelError(
        "constraint_violation",
        `property "${prop.name}" on schema "${schemaName}" has "ui_access" ${JSON.stringify(prop.constraints.ui_access)}; expected one of ${UI_ACCESS_LEVELS.join(", ")}`,
      );
    }
  }
}

/** A property no command can update: constant, generated, the key, or any property of a constant schema. */
function cannotBeUpdated(schema: NormalizedSchema, prop: NormalizedProperty): boolean {
  return (
    prop.constraints.constant === true ||
    schema.constraints.constant === true ||
    prop.constraints.__generated === true ||
    keyPropertyName(schema) === prop.name
  );
}

/**
 * The level a user interface may expose a schema, or one of its properties.
 * Without `propertyName`, the schema's `ui_access` (`read_only` when absent).
 * With one, the lowest of the schema's level, the property's own `ui_access`
 * (the schema's level when absent) and, for a property that cannot be updated,
 * `read_only`. A property cannot be updated when it is `constant`, the key of a
 * shared instance (`name` of a `shared_by_name` schema, `id` of another shared
 * schema), a property of a `constant` schema, or generated (an inverse
 * relation). A `hidden` schema hides all its properties. Advisory: nothing in
 * command processing consults it.
 * Throws `unknown_property` when the schema has no such property.
 */
export function uiAccessOf(schema: NormalizedSchema, propertyName?: string): UiAccess {
  const declared = schema.constraints.ui_access;
  const schemaLevel = isUiAccess(declared) ? declared : DEFAULT_SCHEMA_LEVEL;
  if (propertyName === undefined) return schemaLevel;

  const prop = findProperty(schema, propertyName);
  if (!prop) {
    throw modelError("unknown_property", `"${propertyName}" is not a property of "${schema.name}"`);
  }
  const own = isUiAccess(prop.constraints.ui_access) ? prop.constraints.ui_access : schemaLevel;
  return lowest(schemaLevel, own, cannotBeUpdated(schema, prop) ? "read_only" : "editable");
}

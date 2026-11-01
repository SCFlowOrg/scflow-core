import type { NormalizedProperty, NormalizedSchema } from "./types.js";

/**
 * Small helpers reading the schema-level constraints defined in
 * document_part-definition-schema_constraints.md / document_part-concept-ownership.md.
 * Centralized here so command.ts, filter.ts and api.ts agree on what they mean.
 */

/** Whether the schema is `embedded`: its instances live inside their owner and have no key of their own. */
export function isEmbedded(schema: NormalizedSchema): boolean {
  return schema.constraints.embedded === true;
}

/** Whether the schema is `shared_by_name`: its instances are keyed by their `name`. */
export function isSharedByName(schema: NormalizedSchema): boolean {
  return schema.constraints.shared_by_name === true;
}

/** Every non-embedded schema is "shared" — by name if `shared_by_name`, else by generated id. */
export function isShared(schema: NormalizedSchema): boolean {
  return !isEmbedded(schema);
}

/** Whether the schema is `is_root`: its instances have no owner instance, the dataset owns them. */
export function isRoot(schema: NormalizedSchema): boolean {
  return schema.constraints.is_root === true;
}

/** "name" for shared_by_name schemas, "id" for plain shared schemas, null if embedded. */
export function keyPropertyName(schema: NormalizedSchema): "name" | "id" | null {
  if (isEmbedded(schema)) return null;
  return isSharedByName(schema) ? "name" : "id";
}

/** The property of `schema` called `name`, or `undefined` when it has none. */
export function findProperty(schema: NormalizedSchema, name: string): NormalizedProperty | undefined {
  return schema.properties.find((p) => p.name === name);
}

/** Relation properties that own the instance they point at ("this is owned by that"). */
export function ownerProperties(schema: NormalizedSchema): NormalizedProperty[] {
  return schema.properties.filter((p) => p.constraints.owner === true);
}

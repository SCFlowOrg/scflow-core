import { modelError } from "./errors.js";
import { NAME_SEPARATOR } from "./schema.js";
import type { NormalizedProperty, NormalizedSchema, TransientObject, TransientValue } from "./types.js";

/**
 * The declaration of the schema constraint `name_scope`, per
 * packages/core/docs/spec/meta-model.md#names-and-references, as schema
 * processing reads it: what one schema decides alone. That each relation of the
 * list is a single-valued relation to a schema with `name_scope` needs the
 * whole model and is checked by `validateRules`; the uniqueness of names and
 * the references live in `names.ts`.
 */

/**
 * Checks the declaration of `name_scope` of a schema being processed, each
 * breach a `constraint_violation`: a list of the names of properties, with no
 * name twice; a property `name` of type `string` or `localized_string`; not
 * together with `shared_by_name`, `embedded` or `facet_of`; and, through
 * `extends`, the list of the parent, which an extending schema cannot change.
 * A schema without `name_scope` is not checked.
 */
export function validateNameScopeDeclaration(
  schemaName: string,
  properties: NormalizedProperty[],
  constraints: Record<string, TransientValue>,
  own: Record<string, TransientValue>,
  parent: NormalizedSchema | undefined,
): void {
  if (constraints.name_scope === undefined) return;
  const fail = (message: string): never => {
    throw modelError("constraint_violation", `schema "${schemaName}": ${message}`);
  };
  const scope = constraints.name_scope;
  if (!Array.isArray(scope) || scope.some((r) => typeof r !== "string")) fail(`"name_scope" is a list of the names of relations; an empty list means the scope is the dataset`);
  const relations = scope as unknown as string[];
  if (new Set(relations).size !== relations.length) fail(`"name_scope" names a relation twice`);
  for (const other of ["shared_by_name", "embedded", "facet_of"]) {
    if (constraints[other] !== undefined && constraints[other] !== false) fail(`"name_scope" is incompatible with "${other}"`);
  }
  if (parent && Array.isArray(parent.constraints.name_scope) && own.name_scope !== undefined && JSON.stringify(own.name_scope) !== JSON.stringify(parent.constraints.name_scope)) {
    fail(`"name_scope" is inherited from "${parent.name}" and cannot be changed by a schema extending it`);
  }
  const name = properties.find((p) => p.name === "name");
  if (!name) fail(`"name_scope" implies a property "name" of type string or localized_string, which the schema does not declare`);
  if (name && name.type !== "string" && name.type !== "localized_string") fail(`"name_scope" implies a property "name" of type string or localized_string, not "${name.type}"`);
}

/**
 * Checks the `name` of an instance of a schema with `name_scope`, as a write
 * gives it: not empty (a map holds at least one text, none empty) and without
 * the separator `/`. A breach is a `constraint_violation`.
 */
export function assertValidName(schemaName: string, name: TransientValue | undefined): void {
  const texts: TransientValue[] =
    typeof name === "string" ? [name] : name !== null && typeof name === "object" && !Array.isArray(name) ? Object.values(name as TransientObject) : [];
  if (texts.length === 0 || texts.some((t) => typeof t !== "string" || t.trim() === "")) {
    throw modelError("constraint_violation", `"name" is mandatory and not empty on "${schemaName}"`);
  }
  for (const text of texts as string[]) {
    if (text.includes(NAME_SEPARATOR)) {
      throw modelError("constraint_violation", `the name ${JSON.stringify(text)} of "${schemaName}" contains "${NAME_SEPARATOR}", which separates the parts of a qualified name; write the name without it`);
    }
  }
}

/**
 * Refuses `shared_by_name` on a schema that is not a schema of the meta-model
 * (a module's or a dataset's own): only the meta-model keys its schemas by
 * `name`, so a name that is a key is never a business name. A
 * `constraint_violation`; `name_scope` covers what other schemas need.
 */
export function refuseSharedByNameOutsideMetaModel(schema: NormalizedSchema): NormalizedSchema {
  if (schema.constraints.shared_by_name !== undefined && schema.constraints.shared_by_name !== false) {
    throw modelError(
      "constraint_violation",
      `schema "${schema.name}" is shared_by_name, which only the schemas of the meta-model are; declare "name_scope" to refer to its instances by name, or refer to them by id`,
    );
  }
  return schema;
}

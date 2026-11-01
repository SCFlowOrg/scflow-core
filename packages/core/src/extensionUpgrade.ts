import { computePropertyValue } from "./command.js";
import { writeExtensionInstance } from "./extensionData.js";
import { addedProperties, extensionRelationOf } from "./extensions.js";
import type { Resolvers } from "./resolvers.js";
import { keyPropertyName } from "./schema.js";
import { derivePropertyRoles, resolveType } from "./schemaProcessing.js";
import type { NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/** Whether `schema` is the schema called `ancestor` or extends it, directly or through further extension. */
function isSchemaOrDescendant(schema: NormalizedSchema, ancestor: string, resolvers: Resolvers): boolean {
  const seen = new Set<string>();
  let current: NormalizedSchema | undefined = schema;
  while (current && !seen.has(current.name)) {
    if (current.name === ancestor) return true;
    seen.add(current.name);
    current = current.extends ? resolvers.schemas.get(current.extends) : undefined;
  }
  return false;
}

/**
 * Creates, for every extension schema of the model in `resolvers`, the instance
 * it lacks for each stored instance of the schema it extends or of a schema
 * extending that one, with the default value of each property it adds. What an
 * upgrade adding an extension to a populated dataset does, see the part
 * `model_upgrade` of the document `model`; an instance that already has its
 * extension instance is left as it is. Returns the number of instances created.
 */
export async function ensureExtensionInstances(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  datasetValue: TransientValue,
): Promise<number> {
  let created = 0;
  for (const extension of resolvers.schemas.values()) {
    const relation = extensionRelationOf(extension);
    if (!relation) continue;
    const extensionRoles = derivePropertyRoles(extension);
    for (const holder of resolvers.schemas.values()) {
      const keyProperty = keyPropertyName(holder);
      if (!keyProperty || !isSchemaOrDescendant(holder, relation.type, resolvers)) continue;
      for (const raw of await impl.listInstances(rest, holder.name, derivePropertyRoles(holder))) {
        const key = (raw as TransientObject)[keyProperty];
        if (typeof key !== "string") continue;
        if ((await impl.getInstance(rest, extension.name, key, extensionRoles)) !== null) continue;
        const values: TransientObject = {};
        for (const prop of addedProperties(extension)) {
          values[prop.name] = computePropertyValue(prop, false, undefined, resolveType(prop.type, resolvers.ctx), values, holder, datasetValue);
        }
        await writeExtensionInstance(impl, rest, extension, key, values);
        created++;
      }
    }
  }
  return created;
}

import { addedProperties, extensionNamesOf, extensionRelationOf, propertiesOfExtension } from "./extensions.js";
import { derivePropertyRoles } from "./schemaProcessing.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/**
 * The instances of an extension schema E: one per instance of the schema T it
 * extends, stored under E with the key of that instance, holding the values of
 * the properties E adds to T (see `extensions.ts` and the part `relations`
 * (*Extensions*) of the document `model` in the `core` dataset). The instance of
 * T never stores them: they are read into it on demand and written out to E.
 */

function copy(value: TransientValue): TransientValue {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Reads into `instance`, an instance of `schema` with key `key`, the values the
 * extensions of `schema` hold for it. An extension with no instance for `key`
 * leaves its properties as they are. Returns `instance`.
 */
export async function mergeExtensionValues(
  impl: PersistenceInterface,
  rest: string,
  ctx: TypeResolutionContext,
  schema: NormalizedSchema,
  key: Key,
  instance: TransientObject,
): Promise<TransientObject> {
  for (const extensionName of extensionNamesOf(schema)) {
    const extension = ctx.resolveSchema(extensionName);
    if (!extension) continue;
    const stored = await impl.getInstance(rest, extensionName, key, derivePropertyRoles(extension));
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) continue;
    for (const prop of propertiesOfExtension(schema, extensionName)) {
      if (Object.prototype.hasOwnProperty.call(stored, prop.name)) instance[prop.name] = copy((stored as TransientObject)[prop.name]);
    }
  }
  return instance;
}

/**
 * Stores the instance of `extension` for the instance with key `key` of the
 * schema it extends: the key, the value of the `extension` relation (the same
 * key) and `values` for the properties the extension adds. It is created when
 * absent and replaced otherwise.
 */
export async function writeExtensionInstance(
  impl: PersistenceInterface,
  rest: string,
  extension: NormalizedSchema,
  key: Key,
  values: TransientObject,
): Promise<void> {
  const relation = extensionRelationOf(extension);
  if (!relation) return;
  const stored: TransientObject = { id: key, [relation.name]: key };
  for (const prop of addedProperties(extension)) {
    const value = values[prop.name];
    if (value !== undefined) stored[prop.name] = copy(value);
  }
  await impl.putInstance(rest, extension.name, key, stored, derivePropertyRoles(extension));
}

/**
 * Stores, for each extension of `schema`, the instance holding the values
 * `instance` has for the properties of that extension, under the key `key`.
 */
export async function writeExtensionInstances(
  impl: PersistenceInterface,
  rest: string,
  ctx: TypeResolutionContext,
  schema: NormalizedSchema,
  key: Key,
  instance: TransientObject,
): Promise<void> {
  for (const extensionName of extensionNamesOf(schema)) {
    const extension = ctx.resolveSchema(extensionName);
    if (!extension) continue;
    const values: TransientObject = {};
    for (const prop of propertiesOfExtension(schema, extensionName)) values[prop.name] = instance[prop.name];
    await writeExtensionInstance(impl, rest, extension, key, values);
  }
}

/** Deletes, for each extension of `schema`, the instance stored under `key`, when there is one. */
export async function deleteExtensionInstances(
  impl: PersistenceInterface,
  rest: string,
  ctx: TypeResolutionContext,
  schema: NormalizedSchema,
  key: Key,
): Promise<void> {
  for (const extensionName of extensionNamesOf(schema)) {
    const extension = ctx.resolveSchema(extensionName);
    if (!extension) continue;
    if ((await impl.getInstance(rest, extensionName, key, derivePropertyRoles(extension))) !== null) {
      await impl.deleteInstance(rest, extensionName, key);
    }
  }
}

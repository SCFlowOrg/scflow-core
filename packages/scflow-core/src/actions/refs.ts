import type { MclAccess } from "@scfloworg/core";

/** An instance of a schema, as a query returns it: its `id` and its properties. */
export type Instance = Record<string, unknown> & { id: string };

/**
 * Finds the instance that a reference designates.
 *
 * The reference is the id of the instance, or the exact `display_name` of one
 * instance, in any language. An id wins over a name that equals it. A reference
 * to a schema without `display_name` can only be an id.
 *
 * @param mcl The access to the dataset.
 * @param locator The locator of the dataset.
 * @param schema The schema of the instance, for example `"actor"`.
 * @param ref The id or the name given by the caller.
 * @param param The name of the parameter, quoted in the error message.
 * @returns The instance.
 * @throws When the reference is empty, matches no instance, or is a name shared by several instances (the error lists their ids).
 */
export async function resolveRef(
  mcl: MclAccess,
  locator: string,
  schema: string,
  ref: unknown,
  param: string,
): Promise<Instance> {
  if (typeof ref !== "string" || ref === "") {
    throw new Error(`parameter "${param}": expected the id or the name of a ${schema}`);
  }
  const { after } = await mcl.runCommand(locator, { kind: "query", schema });
  const instances = after as unknown as Instance[];

  const byId = instances.find((instance) => instance.id === ref);
  if (byId) {
    return byId;
  }
  const byName = instances.filter((instance) => namesOf(instance).includes(ref));
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length === 0) {
    throw new Error(`parameter "${param}": ${schema} "${ref}" not found`);
  }
  const ids = byName.map((instance) => instance.id).join(", ");
  throw new Error(`parameter "${param}": ${schema} name "${ref}" is ambiguous, it matches ${ids}`);
}

/**
 * Finds the entity that an id designates, whatever its schema, by a query on the
 * base schema `annotable`.
 *
 * `resolveRef` is not used: the entities carry a `display_name`, and the actions
 * that act on any entity (notes, tags) designate it by its id alone.
 *
 * @param mcl The access to the dataset.
 * @param locator The locator of the dataset.
 * @param entity The id given by the caller.
 * @param param The name of the parameter, quoted in the error message.
 * @returns The instance.
 * @throws When the id is not a non-empty string or matches no entity.
 */
export async function resolveEntity(mcl: MclAccess, locator: string, entity: unknown, param: string): Promise<Instance> {
  if (typeof entity !== "string" || entity === "") {
    throw new Error(`parameter "${param}": expected the id of an entity`);
  }
  const { after } = await mcl.runCommand(locator, { kind: "query", schema: "annotable", filters: { id: entity } });
  const found = (after as unknown as Instance[])[0];
  if (!found) {
    throw new Error(`parameter "${param}": no entity with id "${entity}"`);
  }
  return found;
}

/** The names of an instance, one per language of its `display_name`. */
export function namesOf(instance: Instance): string[] {
  const displayName = instance.display_name;
  if (typeof displayName !== "object" || displayName === null) {
    return [];
  }
  return Object.values(displayName as Record<string, unknown>).filter(
    (name): name is string => typeof name === "string",
  );
}

/**
 * A short label of an instance for an error message: its first display name, or its id.
 */
export function labelOf(instance: Instance): string {
  return namesOf(instance)[0] ?? instance.id;
}

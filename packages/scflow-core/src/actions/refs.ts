import type { ActionAccess } from "./params.js";

/** An instance of a schema, as a query returns it: its `id` and its properties. */
export type Instance = Record<string, unknown> & { id: string };

/**
 * Reads one instance by its key.
 *
 * @param context The access to the dataset.
 * @param schema The qualified name of the schema, for example `"scflow.actor"`.
 * @param id The key of the instance.
 * @returns The instance.
 * @throws When no instance has this key.
 */
export async function loadInstance(context: ActionAccess, schema: string, id: unknown): Promise<Instance> {
  const { after } = await context.runCommand(context.locator, { kind: "query", schema, filters: { id: id as string } });
  const found = (after as unknown as Instance[])[0];
  if (!found) {
    throw new Error(`${schema} "${String(id)}" does not exist`);
  }
  return found;
}

/**
 * Finds the instance that a reference designates, for a parameter whose schema
 * is only known when the action runs, which the keyword `ref` cannot name.
 *
 * The reference is the id of the instance, or the exact `display_name` of one
 * instance, in any language. An id wins over a name that equals it.
 *
 * @param context The access to the dataset.
 * @param schema The qualified name of the schema.
 * @param ref The id or the name given by the caller.
 * @param param The name of the parameter, quoted in the error message.
 * @returns The instance.
 * @throws When the reference matches no instance, or is a name shared by several instances (the error lists their ids).
 */
export async function resolveRef(context: ActionAccess, schema: string, ref: string, param: string): Promise<Instance> {
  const { after } = await context.runCommand(context.locator, { kind: "query", schema });
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

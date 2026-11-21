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
 * The reference is an id, or a name as short as it stays unambiguous, resolved
 * by the engine (see `docs/spec/schemas.md`, Names).
 *
 * @param context The access to the dataset.
 * @param schema The qualified name of the schema.
 * @param ref The id or the name given by the caller.
 * @param param The name of the parameter, quoted in the error message.
 * @returns The instance.
 * @throws When the reference matches no instance, or several: the error lists the qualified names of the candidates.
 */
export async function resolveRef(context: ActionAccess, schema: string, ref: string, param: string): Promise<Instance> {
  let id: string;
  try {
    id = await context.resolveReference(schema, ref);
  } catch (error) {
    throw new Error(`parameter "${param}": ${(error as Error).message}`);
  }
  return loadInstance(context, schema, id);
}

/** The names of an instance, one per language of its `name`; one text when the name is a plain string. */
export function namesOf(instance: Instance): string[] {
  const name = instance.name;
  if (typeof name === "string") {
    return [name];
  }
  if (typeof name !== "object" || name === null) {
    return [];
  }
  return Object.values(name as Record<string, unknown>).filter((text): text is string => typeof text === "string");
}

/**
 * A short label of an instance for an error message or a result: its reference
 * when `withReferences` has set it, else its first name, or its id.
 */
export function labelOf(instance: Instance): string {
  return typeof instance._reference === "string" ? instance._reference : (namesOf(instance)[0] ?? instance.id);
}

/**
 * Sets on each instance its reference, the shortest name that designates it
 * alone, which `labelOf` then gives. A name that two instances share, such as
 * the `Line 1` of two plants, is thus qualified in what an action returns.
 */
export async function withReferences(context: ActionAccess, schema: string, instances: Instance[]): Promise<Instance[]> {
  for (const instance of instances) {
    instance._reference = await context.referenceOf(schema, instance.id);
  }
  return instances;
}

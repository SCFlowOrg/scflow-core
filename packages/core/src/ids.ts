import { modelError } from "./errors.js";
import type { Key, PersistenceInterface, TransientObject } from "./types.js";

/** The canonical form of a uuid: lowercase hexadecimal digits in groups of 8-4-4-4-12. */
export const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const UUID_REGEX = new RegExp(UUID_PATTERN);

/** Whether `value` is a canonical lowercase uuid (8-4-4-4-12 hexadecimal digits). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

/** Generates a random (version 4) uuid with the runtime's cryptographic generator. */
export function generateUuid(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID !== "function") {
    throw modelError("constraint_violation", "no uuid generator is available in this runtime");
  }
  return cryptoApi.randomUUID();
}

/**
 * Resolves the `id` of an instance created in a schema that is not
 * `shared_by_name`: the `id` the entry supplies, or a generated uuid.
 * A supplied `id` must be a canonical lowercase uuid that no instance of
 * `schema` holds yet, otherwise `constraint_violation`.
 */
export async function resolveCreateId(
  impl: PersistenceInterface,
  rest: string,
  schema: string,
  entry: TransientObject,
  propertyRoles: Record<string, string>,
): Promise<Key> {
  if (!Object.prototype.hasOwnProperty.call(entry, "id") || entry.id === undefined || entry.id === null) {
    return generateUuid();
  }
  const supplied = entry.id;
  if (!isUuid(supplied)) {
    throw modelError("constraint_violation", `the id of a "${schema}" instance must be a canonical lowercase uuid`);
  }
  if ((await impl.getInstance(rest, schema, supplied, propertyRoles)) !== null) {
    throw modelError("constraint_violation", `an instance of "${schema}" already has the id "${supplied}"`);
  }
  return supplied;
}

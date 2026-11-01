import type { ModelActionParamsSchema } from "@scfloworg/core";

/** One property of the JSON Schema of an action's parameters. */
export type ParamProperty = ModelActionParamsSchema["properties"][string];

/** The flow domains, in the declaration order of the `flow_domain` scalar type. */
export const FLOW_DOMAINS = ["physical", "information", "financial", "service"] as const;

/**
 * JSON Schema of a text parameter: a string, or a map of language to string.
 *
 * `ParamProperty` requires a single `type`, which cannot express the union, so
 * the union is declared with `anyOf` and cast.
 */
export function localizedTextParam(description: string): ParamProperty {
  return {
    anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }],
    description,
  } as unknown as ParamProperty;
}

/** JSON Schema of a text parameter that also accepts `null`, to remove the text. */
export function nullableLocalizedTextParam(description: string): ParamProperty {
  return {
    anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }, { type: "null" }],
    description,
  } as unknown as ParamProperty;
}

/** JSON Schema of a parameter that holds the id or the name of an entity. */
export function refParam(description: string): ParamProperty {
  return { type: "string", description };
}

/** JSON Schema of a reference parameter that also accepts `null`, to clear the relation. */
export function nullableRefParam(description: string): ParamProperty {
  return { anyOf: [{ type: "string" }, { type: "null" }], description } as unknown as ParamProperty;
}

/** JSON Schema of a parameter that holds a list of tags. */
export function tagsParam(description: string): ParamProperty {
  return { type: "array", items: { type: "string" }, description };
}

/**
 * Reads an optional list of non-empty strings.
 *
 * @returns The list without duplicates, or `undefined` when the parameter is absent.
 * @throws When the value is not a list of non-empty strings.
 */
export function optionalStringList(value: unknown, param: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`parameter "${param}": expected a list of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

/**
 * Reads an optional boolean.
 *
 * @returns The boolean, or `undefined` when the parameter is absent.
 * @throws When the value is not a boolean.
 */
export function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`parameter "${param}": expected a boolean`);
  }
  return value;
}

/** The roles of a transformation line, in the declaration order of `transformation_role`. */
export const TRANSFORMATION_ROLES = ["consumed", "produced"] as const;

/**
 * Reads a required transformation role.
 *
 * @returns `"consumed"` or `"produced"`.
 * @throws When the value is missing or is neither of the two roles.
 */
export function requireRole(value: unknown, param: string): "consumed" | "produced" {
  if (value !== "consumed" && value !== "produced") {
    throw new Error(`parameter "${param}": expected ${TRANSFORMATION_ROLES.join(" or ")}`);
  }
  return value;
}

/**
 * Reads a required flow domain.
 *
 * @returns The domain.
 * @throws When the value is missing or is not one of the four flow domains.
 */
export function requireDomain(value: unknown, param: string): string {
  if (typeof value !== "string" || !(FLOW_DOMAINS as readonly string[]).includes(value)) {
    throw new Error(`parameter "${param}": expected one of ${FLOW_DOMAINS.join(", ")}`);
  }
  return value;
}

/**
 * Reads an optional list of flow domains.
 *
 * @returns The domains without duplicates, or `undefined` when the parameter is absent.
 * @throws When the list is empty or holds a value that is not a flow domain.
 */
export function optionalDomains(value: unknown, param: string): string[] | undefined {
  const list = optionalStringList(value, param);
  if (list === undefined) {
    return undefined;
  }
  if (list.length === 0) {
    throw new Error(`parameter "${param}": give at least one of ${FLOW_DOMAINS.join(", ")}`);
  }
  const unknown = list.filter((domain) => !(FLOW_DOMAINS as readonly string[]).includes(domain));
  if (unknown.length > 0) {
    throw new Error(`parameter "${param}": unknown flow domain ${unknown.map((d) => `"${d}"`).join(", ")}`);
  }
  return list;
}

import type { DatasetModel, NormalizedSchema } from "@scfloworg/core";
import { splitQualified } from "./layout.js";
import type { SpreadsheetDataset } from "./types.js";

/** What the import needs of the signature of an action: the names it takes and which are required. */
export interface Signature {
  id: string;
  properties: Record<string, unknown>;
  required: string[];
}

/** The signature of `id` among the actions of the dataset, or `undefined` when the dataset runs none of that id. */
export function signatureOf(dataset: SpreadsheetDataset, id: string | undefined): Signature | undefined {
  if (id === undefined) return undefined;
  const action = dataset.actions().find((a) => a.id === id);
  if (!action || action.kind === "read") return undefined;
  let parameters: unknown = action.parameters;
  if (typeof parameters === "string") {
    try {
      parameters = JSON.parse(parameters) as unknown;
    } catch {
      parameters = undefined;
    }
  }
  const schema = (parameters ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
  return { id, properties: schema.properties ?? {}, required: Array.isArray(schema.required) ? (schema.required as string[]) : [] };
}

/** The operation of `crud` of a schema: an action id, or `undefined` when the model offers none. */
function crudAction(schema: NormalizedSchema, operation: "create" | "update"): string | undefined {
  const crud = schema.constraints.crud as Record<string, unknown> | undefined;
  const value = crud?.[operation];
  if (value === "none") return undefined;
  if (typeof value === "string" && value !== "generated") return value;
  const { namespace, short } = splitQualified(schema.name);
  return `${namespace}/${operation}_${short}`;
}

/** The id of the action that creates an instance of `schema`: the one its `crud` names, else the generated one. */
export const createActionOf = (schema: NormalizedSchema): string | undefined => crudAction(schema, "create");

/** The id of the action that updates an instance of `schema`, or of a facet. */
export const updateActionOf = (schema: NormalizedSchema): string | undefined => crudAction(schema, "update");

/** The facet of a qualified name in the model. */
export const facetSchema = (model: DatasetModel, name: string): NormalizedSchema | undefined => model.schemas.get(name);

type JsonSchema = Record<string, unknown> | undefined;

const typeMatches = (type: unknown, value: unknown): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
};

/**
 * Why `value` breaks the JSON Schema `schema` of a parameter, or `null`. Only
 * the keywords the generated actions use are read: `type`, `enum`, `pattern`,
 * `anyOf`, `items`, `additionalProperties`, `minProperties`, `minimum` and
 * `maximum`. A `ref` is the import's own business: it resolves it first.
 */
export function violationOf(schema: JsonSchema, value: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  if (typeof schema.ref === "string") return null;
  if (Array.isArray(schema.anyOf)) {
    const reasons = (schema.anyOf as JsonSchema[]).map((s) => violationOf(s, value));
    return reasons.some((r) => r === null) ? null : (reasons[0] as string);
  }
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? (schema.type as unknown[]) : [schema.type];
  if (types && !types.some((t) => typeMatches(t, value))) return `it must be ${types.join(" or ")}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `it must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `it must not be empty`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `it must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `it must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value) && schema.items) {
    for (const item of value) {
      const reason = violationOf(schema.items as JsonSchema, item);
      if (reason !== null) return reason;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (typeof schema.minProperties === "number" && entries.length < schema.minProperties) return `it needs at least ${schema.minProperties} value`;
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [, v] of entries) {
        const reason = violationOf(schema.additionalProperties as JsonSchema, v);
        if (reason !== null) return reason;
      }
    }
  }
  return null;
}

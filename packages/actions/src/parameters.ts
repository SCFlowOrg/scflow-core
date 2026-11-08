import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { actionError } from "./errors.js";
import { copyJson } from "./json.js";
import type { ActionDefinition, JsonSchema, RefResolver } from "./types.js";

/** A `ref` value met by the validator: where it sits, and the schema it names. */
interface RefSite {
  readonly schema: string;
  readonly value: string;
  readonly parent: Record<string | number, unknown>;
  readonly property: string | number;
}

/** The sites of the validation running now; validation is synchronous, so one list is enough. */
let collecting: RefSite[] | null = null;

/**
 * The validator of every action: JSON Schema draft 2020-12, the version of MCP
 * tools. Unknown keywords are refused, `default` fills absent properties, and
 * `format` is an annotation only, since no format vocabulary is loaded.
 */
const ajv = new Ajv2020({
  allErrors: true,
  useDefaults: true,
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  validateFormats: false,
});

/**
 * `ref` names a schema of the model: the value is the id or the display name
 * of one of its instances. The validator only notes where each value sits;
 * `validateParameters` resolves them once the parameters are valid.
 */
ajv.addKeyword({
  keyword: "ref",
  schemaType: "string",
  errors: false,
  validate(
    schema: string,
    data: unknown,
    _parentSchema?: unknown,
    context?: { parentData: unknown; parentDataProperty: string | number },
  ) {
    if (collecting && typeof data === "string" && context && context.parentData !== undefined) {
      collecting.push({
        schema,
        value: data,
        parent: context.parentData as RefSite["parent"],
        property: context.parentDataProperty,
      });
    }
    return true;
  },
});

const compiled = new WeakMap<object, ValidateFunction>();

/** The parameters of an action that declares none. */
const NO_PARAMETERS: JsonSchema = Object.freeze({ type: "object", properties: Object.freeze({}) });

/**
 * The parameters of a definition as a JSON Schema object: its JSON text read,
 * or an empty object schema when it declares none. Text that is not JSON, or a
 * schema whose `type` is not `object`, is refused with `constraint_violation`.
 */
export function parametersSchema(definition: ActionDefinition): JsonSchema {
  const { parameters } = definition;
  if (parameters === undefined) return NO_PARAMETERS;
  let schema: unknown = parameters;
  if (typeof parameters === "string") {
    try {
      schema = JSON.parse(parameters);
    } catch (error) {
      throw actionError(
        "constraint_violation",
        `${definition.id}: parameters are not JSON: ${(error as Error).message}`,
      );
    }
  }
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as JsonSchema).type !== "object"
  ) {
    throw actionError(
      "constraint_violation",
      `${definition.id}: parameters must be a JSON Schema of type object`,
    );
  }
  return schema as JsonSchema;
}

/**
 * The validator of a parameters schema, compiled once per schema object. A
 * schema that is not a valid JSON Schema, or uses an unknown keyword, is
 * refused with `constraint_violation`.
 */
export function compileParameters(id: string, schema: JsonSchema): ValidateFunction {
  const known = compiled.get(schema);
  if (known) return known;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw actionError(
      "constraint_violation",
      `${id}: parameters are not a valid JSON Schema: ${(error as Error).message}`,
    );
  }
  compiled.set(schema, validate);
  return validate;
}

/**
 * Checks parameters against the JSON Schema of an action and gives the
 * parameters its body receives: a copy, with the `default` of each absent
 * property, and each `ref` value replaced by the key of the instance it names.
 *
 * `undefined` stands for no parameters, an empty object. Parameters that break
 * the schema are refused with `invalid_parameters`. A `ref` value is resolved
 * by `resolveRef` under the rule of the specification: the instance whose id
 * is the value wins; otherwise the one instance whose `display_name` is the
 * value; no instance or several are refused with `invalid_parameters`. Without
 * `resolveRef`, a `ref` value is kept as it is.
 *
 * `validate` is the compiled validator, which a registry keeps; it is compiled
 * from the definition when absent.
 */
export async function validateParameters(
  definition: ActionDefinition,
  params: unknown,
  resolveRef?: RefResolver,
  validate: ValidateFunction = compileParameters(definition.id, parametersSchema(definition)),
): Promise<unknown> {
  const data = params === undefined ? {} : copyJson(params);
  const sites: RefSite[] = [];
  collecting = sites;
  let valid: boolean;
  try {
    valid = validate(data) as boolean;
  } finally {
    collecting = null;
  }
  if (!valid) {
    throw actionError(
      "invalid_parameters",
      `${definition.id}: ${ajv.errorsText(validate.errors, { dataVar: "parameters" })}`,
    );
  }
  if (resolveRef) {
    // A value under several subschemas (allOf, anyOf) is met more than once: resolve it once.
    const done = new Map<object, Set<string | number>>();
    for (const site of sites) {
      const properties = done.get(site.parent) ?? new Set();
      if (properties.has(site.property)) continue;
      properties.add(site.property);
      done.set(site.parent, properties);
      site.parent[site.property] = await resolveKey(definition.id, site, resolveRef);
    }
  }
  return data;
}

async function resolveKey(id: string, site: RefSite, resolveRef: RefResolver): Promise<string> {
  const matches = await resolveRef(site.schema, site.value);
  if (matches.id !== null) return matches.id;
  if (matches.names.length === 1) return matches.names[0];
  const count = matches.names.length === 0 ? "no" : "several";
  throw actionError(
    "invalid_parameters",
    `${id}: "${site.value}" names ${count} instance of ${site.schema}`,
  );
}

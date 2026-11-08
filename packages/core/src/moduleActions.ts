import { resolveCommandForm } from "./command.js";
import type { DatasetModel } from "./datasetModules.js";
import { modelError } from "./errors.js";
import { facetOfProperty, facetTargetOf, namespaceOfName, qualifiedNamespacesOf } from "./facets.js";
import type { LoadedModule } from "./modules.js";
import { findProperty, isEmbedded, keyPropertyName } from "./schema.js";
import { resolveType } from "./schemaProcessing.js";
import type { ResolvedScalar, TypeResolutionContext } from "./schemaProcessing.js";
import type {
  AuthoredCommand,
  CommandResult,
  MclAccess,
  NormalizedProperty,
  NormalizedSchema,
  TransientObject,
  TransientValue,
} from "./types.js";

/**
 * The actions of a module as the engine knows them (see Action in
 * `docs/spec/meta-model.md`): the actions generated from its schemas, the write
 * limit of an action and the resolution of `ref` values. An action here has the
 * shape of an `Action` of `@scfloworg/actions`, which this package does not
 * import.
 */

/** What the body of a generated action receives: access to its dataset. */
export interface GeneratedActionContext extends MclAccess {
  readonly locator: string;
}

/** An action generated from a schema, with its body. */
export interface GeneratedAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly kind: "read" | "action";
  readonly destructive: boolean;
  /** The parameters, a JSON Schema object that may use `ref`. */
  readonly parameters: Record<string, unknown>;
  /** The canonical names of the schemas the action writes. */
  readonly writes: readonly string[];
  run(params: Record<string, unknown>, context: GeneratedActionContext): Promise<unknown>;
}

type JsonSchema = Record<string, unknown>;

/** The JSON Schema of a value of a scalar type. */
function scalarSchema(resolved: ResolvedScalar, prop: NormalizedProperty): JsonSchema {
  const schema: JsonSchema = { type: resolved.base };
  const values = { ...resolved.constraints, ...prop.constraints }.enum;
  if (Array.isArray(values)) schema.enum = values;
  return schema;
}

/** The value of a `default_value`, or `undefined` when it holds a placeholder, which the engine resolves. */
function defaultOf(prop: NormalizedProperty, resolved: ResolvedScalar): TransientValue | undefined {
  const raw = prop.default_value;
  if (raw === null || prop.constraints.is_array === true) return undefined;
  if (typeof raw !== "string") return raw;
  if (raw.includes("${")) return undefined;
  if (resolved.base === "number" || resolved.base === "integer") return Number(raw);
  if (resolved.base === "boolean") return raw === "true";
  return raw;
}

/** Whether `prop` is a property of `schema` itself, as authored: neither generated nor brought by a facet or an extension. */
function isAuthoredProperty(prop: NormalizedProperty): boolean {
  return (
    prop.constraints.__generated !== true &&
    prop.constraints.__extension === undefined &&
    prop.constraints.extension !== true &&
    facetOfProperty(prop) === undefined &&
    !prop.name.includes(".")
  );
}

/** The parameter of `prop` in a create, or in an update, where a value that is not mandatory can be cleared. */
function parameterOf(prop: NormalizedProperty, ctx: TypeResolutionContext, forUpdate: boolean): JsonSchema {
  const resolved = resolveType(prop.type, ctx);
  const clearable = forUpdate && prop.constraints.mandatory !== true && prop.constraints.is_array !== true;
  const description = typeof prop.constraints.description === "string" ? { description: prop.constraints.description } : {};
  if (resolved.kind === "relation") {
    return { type: clearable ? ["string", "null"] : "string", ref: prop.type, ...description };
  }
  if (resolved.kind === "map") {
    // an update takes the map operations of a command as well as a whole map
    const values = forUpdate ? {} : { additionalProperties: scalarSchema(resolved.value, prop) };
    return { type: "object", ...values, ...description };
  }
  const value = scalarSchema(resolved, prop);
  if (prop.constraints.is_array === true) return { type: "array", items: value, ...description };
  if (clearable) {
    value.type = [resolved.base, "null"];
    if (Array.isArray(value.enum)) value.enum = [...value.enum, null];
  }
  if (!forUpdate) {
    const fallback = defaultOf(prop, resolved);
    if (fallback !== undefined) value.default = fallback;
  }
  return { ...value, ...description };
}

function objectSchema(properties: JsonSchema, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** The label of a schema name for people: `order_line` gives `order line`. */
const label = (short: string) => short.replace(/_/g, " ");

/** What `crud` offers for `operation`: `generated`, the default, `none` or an action id. */
function crudOf(schema: NormalizedSchema, operation: "create" | "update" | "delete"): TransientValue {
  const crud = schema.constraints.crud as TransientObject | undefined;
  return crud?.[operation] ?? "generated";
}

/**
 * The actions generated for the schemas of `module` in the dataset model
 * `model`: create, update and delete under the namespace of the module, and the
 * update and read of a facet. See Generated actions in
 * `docs/spec/meta-model.md`. A signature never holds the properties of a facet.
 */
export function generatedActions(model: DatasetModel, module: LoadedModule): GeneratedAction[] {
  const ctx = model.set.context();
  const actions: GeneratedAction[] = [];
  for (const short of module.schemas.keys()) {
    const name = `${module.namespace}.${short}`;
    const schema = model.schemas.get(name);
    if (!schema || schema.constraints.abstract === true || isEmbedded(schema)) continue;
    if (schema.properties.some((p) => p.constraints.extension === true)) continue;
    const target = facetTargetOf(schema);
    if (target !== undefined) actions.push(...facetActions(model, module, short, name, schema, target, ctx));
    else actions.push(...schemaActions(module, short, name, schema, ctx));
  }
  return actions;
}

const firstOf = (result: CommandResult): TransientValue => result.after[0] ?? null;

/** The parameter `id` of an action on an instance of `schema`, and its filter. */
function targetOf(model: { schema: string; key: string }) {
  return {
    parameter: { type: "string", ref: model.schema, description: `the ${label(model.schema)} to act on` },
    filter: (id: unknown) => ({ [model.key]: id }) as TransientObject,
  };
}

function updatableProperties(schema: NormalizedSchema, key: string | null): NormalizedProperty[] {
  return schema.properties.filter(
    (p) =>
      isAuthoredProperty(p) && p.name !== key && p.constraints.constant !== true && p.constraints.updated_by === undefined,
  );
}

function schemaActions(
  module: LoadedModule,
  short: string,
  name: string,
  schema: NormalizedSchema,
  ctx: TypeResolutionContext,
): GeneratedAction[] {
  const actions: GeneratedAction[] = [];
  const namespace = module.namespace;
  const key = keyPropertyName(schema) as string;
  const target = targetOf({ schema: name, key });
  const base = { description: schema.description, writes: [name] };
  const singleton = schema.constraints.singleton === true;

  if (!singleton && crudOf(schema, "create") === "generated") {
    const properties: JsonSchema = {};
    const required: string[] = [];
    for (const prop of schema.properties.filter(isAuthoredProperty)) {
      properties[prop.name] = parameterOf(prop, ctx, false);
      if ((prop.constraints.mandatory === true || prop.name === key) && prop.default_value === null) required.push(prop.name);
    }
    actions.push({
      ...base,
      id: `${namespace}/create_${short}`,
      title: `Create ${label(short)}`,
      kind: "action",
      destructive: false,
      parameters: objectSchema(properties, required),
      run: async (params, context) =>
        firstOf(await context.runCommand(context.locator, { create: name, input: [params as TransientObject] } as AuthoredCommand)),
    });
  }

  const updatable = updatableProperties(schema, key);
  if (crudOf(schema, "update") === "generated" && schema.constraints.constant !== true && updatable.length > 0) {
    const properties: JsonSchema = { id: target.parameter };
    for (const prop of updatable) properties[prop.name] = parameterOf(prop, ctx, true);
    actions.push({
      ...base,
      id: `${namespace}/update_${short}`,
      title: `Update ${label(short)}`,
      kind: "action",
      destructive: false,
      parameters: objectSchema(properties, ["id"]),
      async run({ id, ...input }, context) {
        return firstOf(
          await context.runCommand(context.locator, { update: name, filters: target.filter(id), input: [input as TransientObject] } as AuthoredCommand),
        );
      },
    });
  }

  if (!singleton && crudOf(schema, "delete") === "generated") {
    actions.push({
      ...base,
      id: `${namespace}/delete_${short}`,
      title: `Delete ${label(short)}`,
      kind: "action",
      destructive: true,
      parameters: objectSchema(
        { id: target.parameter, cascade: { type: "boolean", default: false, description: "also remove what needs a confirmation" } },
        ["id"],
      ),
      async run({ id, cascade }, context) {
        const command = { delete: name, filters: target.filter(id), ...(cascade === true ? { cascade: true } : {}) };
        return context.runCommand(context.locator, command as AuthoredCommand);
      },
    });
  }
  return actions;
}

function facetActions(
  model: DatasetModel,
  module: LoadedModule,
  short: string,
  name: string,
  facet: NormalizedSchema,
  targetName: string,
  ctx: TypeResolutionContext,
): GeneratedAction[] {
  const actions: GeneratedAction[] = [];
  const namespace = module.namespace;
  const targetSchema = model.schemas.get(targetName) as NormalizedSchema;
  const target = targetOf({ schema: targetName, key: keyPropertyName(targetSchema) as string });
  const updatable = updatableProperties(facet, null);

  if (crudOf(facet, "update") === "generated" && updatable.length > 0) {
    const properties: JsonSchema = { id: target.parameter };
    for (const prop of updatable) properties[prop.name] = parameterOf(prop, ctx, true);
    actions.push({
      id: `${namespace}/update_${short}`,
      title: `Update ${label(short)}`,
      description: facet.description,
      kind: "action",
      destructive: false,
      parameters: objectSchema(properties, ["id"]),
      writes: [name],
      async run({ id, ...values }, context) {
        const input = { [namespace]: values } as TransientObject;
        const result = await context.runCommand(context.locator, { update: targetName, filters: target.filter(id), input: [input] } as AuthoredCommand);
        return ((firstOf(result) as TransientObject | null)?.[namespace] ?? {}) as TransientValue;
      },
    });
  }

  actions.push({
    id: `${namespace}/get_${short}`,
    title: `Read ${label(short)}`,
    description: facet.description,
    kind: "read",
    destructive: false,
    parameters: objectSchema({ id: target.parameter }, ["id"]),
    writes: [],
    async run({ id }, context) {
      const result = await context.runCommand(context.locator, { query: targetName, filters: target.filter(id) } as AuthoredCommand);
      return ((firstOf(result) as TransientObject | null)?.[namespace] ?? {}) as TransientValue;
    },
  });
  return actions;
}

/** Whether `value` is a mapping. */
function isMapping(value: unknown): value is TransientObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Refuses, with `write_not_declared`, a command of an action of module
 * `moduleKey` that writes outside `writes`, the canonical names of the schemas
 * it declares. A `create` and a `delete` write the schema of the command; an
 * `update` writes it when it sets one of its own properties, and writes a facet
 * for each property of that facet it sets. A query writes nothing, and a schema
 * that does not resolve is left for the command to refuse.
 */
export function checkActionWrite(
  model: DatasetModel,
  moduleKey: string,
  writes: ReadonlySet<string>,
  raw: AuthoredCommand,
): void {
  const command = resolveCommandForm(raw) as unknown as { kind: string; schema: string; input?: unknown };
  if (command.kind === "query") return;
  const refuse = (what: string): never => {
    throw modelError("write_not_declared", `an action of "${moduleKey}" writes ${what}, outside its writes`);
  };
  let name: string | undefined;
  try {
    name = model.set.resolveSchema(command.schema, moduleKey)?.key;
  } catch {
    refuse(`"${command.schema}"`);
  }
  if (name === undefined) {
    // a name of the model itself, not of a module, is a write the action does not declare
    if (model.schemas.has(command.schema)) name = command.schema;
    else return;
  }
  const schema = model.schemas.get(name);
  if (command.kind !== "update") {
    if (!writes.has(name)) refuse(`"${name}"`);
    if (command.kind === "delete" || !schema) return;
  }
  if (!schema) return refuse(`"${name}"`);
  const namespaces = qualifiedNamespacesOf(schema);
  const entries = Array.isArray(command.input) ? command.input : [command.input];
  for (const item of entries) {
    if (!isMapping(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      const namespace = namespaces.includes(key) ? key : namespaceOfName(key);
      if (namespace === undefined || !namespaces.includes(namespace)) {
        if (!writes.has(name)) refuse(`"${key}" of "${name}"`);
        continue;
      }
      const names = key === namespace && isMapping(value) ? Object.keys(value).map((n) => `${namespace}.${n}`) : [key];
      for (const qualified of names) {
        const prop = findProperty(schema, qualified);
        const facet = prop ? facetOfProperty(prop) : undefined;
        if (prop && (facet === undefined || !writes.has(facet))) refuse(`"${qualified}" of "${name}"`);
      }
    }
  }
}

/** What finds the instances a `ref` value names: see `RefResolver` of `@scfloworg/actions`. */
export type EngineRefResolver = (schema: string, value: string) => Promise<{ id: string | null; names: string[] }>;

/**
 * The resolver of `ref` values on a dataset of model `model`: the key of the
 * instance whose id is the value, and the keys of the instances whose
 * `display_name` is the value, in any language. `query` runs a command on the
 * dataset. A schema that does not resolve has no instance.
 */
export function createRefResolver(
  model: DatasetModel,
  query: (command: AuthoredCommand) => Promise<CommandResult>,
): EngineRefResolver {
  return async (name, value) => {
    const schema = model.schemas.get(name);
    if (!schema) return { id: null, names: [] };
    const key = keyPropertyName(schema) as string;
    let id: string | null = null;
    const names: string[] = [];
    for (const instance of (await query({ query: name } as AuthoredCommand)).after as TransientObject[]) {
      const instanceKey = instance[key] as string;
      if (instanceKey === value) id = instanceKey;
      const label = instance.display_name;
      if (label === value || (isMapping(label) && Object.values(label).includes(value))) names.push(instanceKey);
    }
    return { id, names };
  };
}

/**
 * The canonical form of the `ref` values of `parameters`, as written in module
 * `moduleKey`: a short name becomes the qualified one, so one resolver serves
 * every module. A `ref` that names no schema throws `constraint_violation`.
 */
export function canonicalParameters(
  model: DatasetModel,
  moduleKey: string,
  id: string,
  parameters: unknown,
): unknown {
  const parsed = typeof parameters === "string" ? (tryParse(parameters) ?? parameters) : parameters;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isMapping(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "ref" && typeof inner === "string") {
        const resolved = model.set.resolveSchema(inner, moduleKey);
        if (!resolved) throw modelError("constraint_violation", `action "${id}": "ref" names "${inner}", which is no schema`);
        copy[key] = resolved.key;
      } else copy[key] = walk(inner);
    }
    return copy;
  };
  return walk(parsed);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

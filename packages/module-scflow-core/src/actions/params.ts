import type { GeneratedActionContext } from "@scfloworg/core";

/**
 * What the body of an action reaches the dataset through: an `MclAccess` and the
 * locator of the dataset the action runs on. An `ActionContext` of
 * `@scfloworg/environment` is one.
 */
/** The access to the dataset that the helpers on the model need: its commands only. */
export type DatasetAccess = GeneratedActionContext;

export type ActionAccess = GeneratedActionContext & {
  /** Resolves a reference, an id or a name, to the key of an instance of `schema`; see `resolveReference` of `ActionContext`. */
  resolveReference(schema: string, text: string): Promise<string>;
  /** The reference of an instance: its name as short as it stays unambiguous; its key when the schema has no name. */
  referenceOf(schema: string, key: string): Promise<string>;
};

/** The parameters of an action, a JSON Schema object that may use the keyword `ref`. */
export interface ActionParameters {
  type: "object";
  properties: Record<string, ParamProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
  minProperties?: number;
}

/**
 * A model action of the package, with the shape of an `Action` of
 * `@scfloworg/actions`: its declaration, which agrees with `module.yaml`, and
 * its body. The registry checks the parameters and resolves each `ref` to a key
 * before `run`, so a body validates nothing by hand.
 */
export interface ScflowActionDefinition<TParams, TResult> {
  /** The namespace of the module, a slash and a name. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** `read` writes nothing; `action`, the default, writes. */
  readonly kind?: "read" | "action";
  /** Whether the action may destroy data. */
  readonly destructive?: boolean;
  /** The short names of the schemas of `scflow:core` the action writes. */
  readonly writes: readonly string[];
  readonly parameters: ActionParameters;
  run(params: TParams, context: ActionAccess): Promise<TResult>;
}

/** One property of the JSON Schema of an action's parameters. */
export interface ParamProperty {
  type: string;
  description?: string;
  [key: string]: unknown;
}

/** The flow domains, in the declaration order of the `flow_domain` scalar type. */
export const FLOW_DOMAINS = ["physical", "information", "financial", "service"] as const;

/** A text that holds something else than white space. */
const TEXT = { type: "string", pattern: "\\S" };

/** A string, or a non-empty map of language to string. */
const LOCALIZED = [TEXT, { type: "object", minProperties: 1, additionalProperties: TEXT }];

/**
 * JSON Schema of a text parameter: a string, or a map of language to string.
 *
 * `ParamProperty` requires a single `type`, which cannot express the union, so
 * the union is declared with `anyOf` and cast.
 */
export function localizedTextParam(description: string): ParamProperty {
  return { anyOf: LOCALIZED, description } as unknown as ParamProperty;
}

/** JSON Schema of a text parameter that also accepts `null`, to remove the text. */
export function nullableLocalizedTextParam(description: string): ParamProperty {
  return { anyOf: [...LOCALIZED, { type: "null" }], description } as unknown as ParamProperty;
}

/** JSON Schema of a plain text parameter: a non-blank string. */
export function textParam(description: string): ParamProperty {
  return { type: "string", pattern: TEXT.pattern, description };
}

/** The schemas referred to by name (`name_scope`), with `true` when their name is a `localized_string`. */
const NAMED_SCHEMAS: Readonly<Record<string, boolean>> = {
  actor: false,
  item: false,
  transformation: false,
  route: false,
  location: false,
  actor_type: true,
  item_type: true,
  flow_type: true,
  transformation_type: true,
  route_type: true,
  scope: true,
};

/**
 * The sentence added to the description of a reference to an instance of
 * `schema`: how to write a name. Empty for a schema that is not referred to by
 * name, whose instances are given by id.
 */
export function referenceHint(schema: string): string {
  const localized = NAMED_SCHEMAS[schema];
  if (localized === undefined) {
    return "";
  }
  return (
    " Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; " +
    "never give an id you were not given. An ambiguity error lists the candidates to choose from." +
    (localized ? " A localized name may be given in any language, but it is written in the source language of the project." : "")
  );
}

/**
 * JSON Schema of a parameter that holds the reference of an instance of
 * `schema`, a short name of the module: an id, or its name as short as it
 * stays unambiguous. The body receives its key.
 */
export function refParam(schema: string, description: string): ParamProperty {
  return { type: "string", ref: schema, description: description + referenceHint(schema) };
}

/** JSON Schema of a reference parameter that also accepts `null`, to clear the relation. */
export function nullableRefParam(schema: string, description: string): ParamProperty {
  return { type: ["string", "null"], ref: schema, description: description + referenceHint(schema) } as unknown as ParamProperty;
}

/** JSON Schema of a parameter that holds a list of tags. */
export function tagsParam(description: string): ParamProperty {
  return { type: "array", items: { type: "string", minLength: 1 }, description };
}

/** JSON Schema of the `cascade` parameter of a delete action. */
export function cascadeParam(description: string): ParamProperty {
  return { type: "boolean", default: false, description };
}

/** The values of a list without duplicates, or `undefined` when the parameter is absent. */
export function unique<T>(values: readonly T[] | undefined): T[] | undefined {
  return values === undefined ? undefined : [...new Set(values)];
}

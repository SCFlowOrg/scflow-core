import { parametersSchema } from "./parameters.js";
import type { ActionDefinition } from "./types.js";

/** What a host plugs in to describe a call: the names of objects and the translations. */
export interface DescribeOptions {
  /**
   * The name of the instance of `schema` whose key is `id`, or `undefined` when
   * it has none. This package reads no instance: the host does.
   */
  label?(schema: string, id: string): string | undefined | Promise<string | undefined>;
  /**
   * The translation of `key` with `vars`, or `undefined` when there is none.
   * The keys are `action.<id>.title`, `action.<id>.param.<name>` and
   * `action.<id>.summary`, whose variables are the parameters as they are shown.
   */
  t?(key: string, vars?: Readonly<Record<string, string>>): string | undefined;
  /** The language of the localized texts, tried first. */
  language?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 48;
const MAX_ITEMS = 3;

type Node = Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

/** The id of a call as people read it: no module namespace, spaces for underscores. */
function readableId(id: string): string {
  const name = id.slice(id.lastIndexOf("/") + 1).replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** The subschemas of `schema` that apply to a value, through `anyOf`, `oneOf` and `allOf`. */
function variants(schema: Node | undefined): Node[] {
  if (!schema) return [];
  const nested = ["anyOf", "oneOf", "allOf"].flatMap((keyword) => {
    const list = schema[keyword];
    return Array.isArray(list) ? list.filter(isNode).flatMap((item) => variants(item)) : [];
  });
  return [schema, ...nested];
}

class Describer {
  constructor(private readonly options: DescribeOptions) {}

  /** A value as it is shown; `schema` is the schema of the value, which names an object when it has `ref`. */
  async show(value: unknown, schema: Node | undefined): Promise<string> {
    if (typeof value === "string") {
      const ref = variants(schema).find((variant) => typeof variant.ref === "string")?.ref as string | undefined;
      if (ref !== undefined && this.options.label) {
        const label = await this.options.label(ref, value);
        if (label !== undefined) return clip(label);
      }
      if (UUID.test(value)) return "…" + value.slice(-4);
      return clip(value);
    }
    if (Array.isArray(value)) {
      const items = variants(schema).find((variant) => isNode(variant.items))?.items as Node | undefined;
      const shown = await Promise.all(value.slice(0, MAX_ITEMS).map((item) => this.show(item, items)));
      return shown.join(", ") + (value.length > MAX_ITEMS ? `, +${value.length - MAX_ITEMS}` : "");
    }
    if (isNode(value)) {
      const language = this.options.language;
      const texts = Object.entries(value);
      // A localized text is a map of language to string: only one language is shown.
      if (texts.length > 0 && texts.every(([, text]) => typeof text === "string")) {
        const preferred = language === undefined ? undefined : value[language];
        return clip(String(preferred ?? texts[0][1]));
      }
      const properties = variants(schema).find((variant) => isNode(variant.properties))?.properties as Node | undefined;
      const parts = await this.parts(value, properties);
      return `{${parts.join(", ")}}`;
    }
    return String(value);
  }

  /** The `name value` parts of an object, without the empty values. */
  async parts(
    params: Node,
    properties: Node | undefined,
    action?: string,
  ): Promise<string[]> {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      const property = isNode(properties?.[name]) ? (properties[name] as Node) : undefined;
      const label = (action && this.options.t?.(`action.${action}.param.${name}`)) || name;
      parts.push(`${label}=${await this.show(value, property)}`);
    }
    return parts;
  }
}

/**
 * The call of an action as a short line for a person who approves it: the
 * title of the action, then its parameters by name and value. A value that
 * names an instance (`ref`) is shown by the name `options.label` gives, never
 * by its uuid; a uuid that is not found is cut to its last four characters.
 * Texts come from `options.t`, then from the `title` of the action, then from
 * its id.
 */
export async function describeCall(
  action: ActionDefinition,
  params: unknown,
  options: DescribeOptions = {},
): Promise<string> {
  const describer = new Describer(options);
  const schemaProperties = parametersSchema(action).properties;
  const properties = isNode(schemaProperties) ? schemaProperties : undefined;
  const title = options.t?.(`action.${action.id}.title`) ?? action.title ?? readableId(action.id);
  if (!isNode(params)) return title;
  const parts = await describer.parts(params, properties, action.id);
  if (parts.length === 0) return title;
  const summary = options.t?.(`action.${action.id}.summary`, await shownVariables(describer, params, properties));
  return summary ?? `${title}: ${parts.join(", ")}`;
}

async function shownVariables(describer: Describer, params: Node, properties: Node | undefined): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    vars[name] = await describer.show(value, isNode(properties?.[name]) ? (properties[name] as Node) : undefined);
  }
  return vars;
}

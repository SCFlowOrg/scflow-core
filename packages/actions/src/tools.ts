import { copyJson } from "./json.js";
import { parametersSchema } from "./parameters.js";
import type { ActionDefinition, JsonSchema } from "./types.js";

/** An AI tool, in the shape of an MCP tool definition. */
export interface AiTool {
  /** The id of the action with its slash replaced by a hyphen (see `toolName`). */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** The parameters of the action, a JSON Schema object, `ref` keywords included, in the shape providers accept. */
  readonly inputSchema: JsonSchema;
  readonly annotations: {
    readonly title?: string;
    /** `true` for an action of kind `read`. */
    readonly readOnlyHint: boolean;
    /** `true` for a `destructive` action. */
    readonly destructiveHint: boolean;
  };
}

/**
 * The tool name of an action id: the slash replaced by a hyphen, because AI
 * clients accept only letters, digits, `_` and `-` in a tool name. A hyphen
 * never appears in an identifier, so `actionIdOfTool` gives the id back.
 */
export function toolName(id: string): string {
  return id.replace("/", "-");
}

/** The action id of a tool name made by `toolName`, or `undefined` when the name has no hyphen. */
export function actionIdOfTool(name: string): string | undefined {
  const at = name.indexOf("-");
  return at < 0 ? undefined : `${name.slice(0, at)}/${name.slice(at + 1)}`;
}

/** What AI providers refuse at the top level of the schema of a tool. */
const TOP_LEVEL_REFUSED = ["anyOf", "oneOf", "allOf"] as const;

/** The properties of an `anyOf` whose branches each require one property, else `undefined`. */
function atLeastOneOf(anyOf: unknown): string[] | undefined {
  if (!Array.isArray(anyOf) || anyOf.length === 0) return undefined;
  const names: string[] = [];
  for (const branch of anyOf as Record<string, unknown>[]) {
    const required = branch?.required;
    if (Object.keys(branch ?? {}).length !== 1 || !Array.isArray(required) || required.length !== 1) return undefined;
    names.push(String(required[0]));
  }
  return names;
}

/** What the tools of a project are told about it. */
export interface ToolOptions {
  /**
   * The ordered `languages` of the dataset, the first being the source
   * language. The description of each localized text parameter then names them.
   * Left out or empty (not stated), the descriptions are not changed.
   */
  readonly languages?: readonly string[] | undefined;
}

/** Whether a parameter schema is a localized text: a string, or a map of language to string, in an `anyOf`. */
function isLocalizedText(node: Record<string, unknown>): boolean {
  const branches = node.anyOf;
  if (!Array.isArray(branches)) return false;
  const isMapOfStrings = (branch: Record<string, unknown>) => {
    const values = branch.additionalProperties as Record<string, unknown> | undefined;
    return branch.type === "object" && typeof values === "object" && values !== null && values.type === "string";
  };
  return (
    branches.some((branch) => (branch as Record<string, unknown>)?.type === "string") &&
    branches.some((branch) => branch !== null && typeof branch === "object" && isMapOfStrings(branch as Record<string, unknown>))
  );
}

/** The sentence added to a localized parameter: the languages of the project and its source language. */
export function languagesNote(languages: readonly string[]): string {
  return `Write this text only in the languages of the project: ${languages.join(", ")}. The source language is ${languages[0]}. Give an object keyed by language code.`;
}

/** Appends `languagesNote` to every localized text found in `node`, in place. */
function nameLanguages(node: unknown, note: string): void {
  if (Array.isArray(node)) {
    for (const entry of node) nameLanguages(entry, note);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const object = node as Record<string, unknown>;
  if (isLocalizedText(object)) {
    object.description = [object.description, note].filter((part) => typeof part === "string" && part !== "").join(" ");
    return;
  }
  for (const value of Object.values(object)) nameLanguages(value, note);
}

/**
 * The parameters of an action as `parametersSchema` gives them, with the
 * languages of the project named in the description of each localized text.
 * Gives the schema itself when `languages` is absent or empty.
 */
export function parametersWithLanguages(action: ActionDefinition, languages: readonly string[] | undefined): JsonSchema {
  const schema = parametersSchema(action);
  if (!languages || languages.length === 0) return schema;
  const copy = copyJson(schema);
  nameLanguages(copy, languagesNote(languages));
  return copy as JsonSchema;
}

/** The AI tool of one action, whatever its exposure. */
export function toAiTool(action: ActionDefinition, options: ToolOptions = {}): AiTool {
  const { title } = action;
  const inputSchema = copyJson(parametersWithLanguages(action, options.languages)) as Record<string, unknown>;
  const required = atLeastOneOf(inputSchema.anyOf);
  for (const keyword of TOP_LEVEL_REFUSED) delete inputSchema[keyword];
  const rule = required ? `Give at least one of: ${required.join(", ")}.` : undefined;
  const description = rule ? [action.description, rule].filter(Boolean).join(" ") : action.description;
  return {
    name: toolName(action.id),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    inputSchema: inputSchema as JsonSchema,
    annotations: {
      ...(title === undefined ? {} : { title }),
      readOnlyHint: action.kind === "read",
      destructiveHint: action.destructive === true,
    },
  };
}

/**
 * Exports actions to AI tools: the `visible` actions, in
 * order, each by `toAiTool`. An action whose `exposure` is `hidden` is left
 * out, because the author of the model says what an AI should use.
 */
export function toAiTools(actions: Iterable<ActionDefinition>, options: ToolOptions = {}): AiTool[] {
  return [...actions].filter((action) => action.exposure !== "hidden").map((action) => toAiTool(action, options));
}

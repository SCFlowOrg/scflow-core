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

/** The AI tool of one action, whatever its exposure. */
export function toAiTool(action: ActionDefinition): AiTool {
  const { title } = action;
  const inputSchema = copyJson(parametersSchema(action)) as Record<string, unknown>;
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
export function toAiTools(actions: Iterable<ActionDefinition>): AiTool[] {
  return [...actions].filter((action) => action.exposure !== "hidden").map(toAiTool);
}

import { copyJson } from "./json.js";
import { parametersSchema } from "./parameters.js";
import type { ActionDefinition, JsonSchema } from "./types.js";

/** An AI tool, in the shape of an MCP tool definition. */
export interface AiTool {
  /** The id of the action with its slash replaced by a hyphen (see `toolName`). */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** The parameters of the action, a JSON Schema object, `ref` keywords included. */
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

/** The AI tool of one action, whatever its exposure. */
export function toAiTool(action: ActionDefinition): AiTool {
  const { title, description } = action;
  return {
    name: toolName(action.id),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    inputSchema: copyJson(parametersSchema(action)),
    annotations: {
      ...(title === undefined ? {} : { title }),
      readOnlyHint: action.kind === "read",
      destructiveHint: action.destructive === true,
    },
  };
}

/**
 * Exports actions to AI tools, a plain mapping: the `visible` actions, in
 * order, each by `toAiTool`. An action whose `exposure` is `hidden` is left
 * out, because the author of the model says what an AI should use.
 */
export function toAiTools(actions: Iterable<ActionDefinition>): AiTool[] {
  return [...actions].filter((action) => action.exposure !== "hidden").map(toAiTool);
}

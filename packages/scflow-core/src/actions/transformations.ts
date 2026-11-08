import { type Instance } from "./refs.js";
import { cascadeParam, unique, tagsParam, type ActionAccess, type ScflowActionDefinition, localizedTextParam, refParam } from "./params.js";
import { deleteById } from "./delete-impact.js";
import { holdItem } from "./items.js";
import { toLocalized } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_transformation_type`. */
export interface CreateTransformationTypeParams {
  display_name: Text;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/create_transformation`. */
export interface CreateTransformationParams {
  actor: string;
  type: string;
  display_name?: Text;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/connect_transformation_line`. */
export interface ConnectTransformationLineParams {
  transformation: string;
  held_item: string;
  role: "consumed" | "produced";
  tags?: string[];
}

/** Parameters of `scflow/define_process`. */
export interface DefineProcessParams {
  actor: string;
  transformation_type: string;
  consumed_items?: string[];
  produced_items?: string[];
}

/** Parameters of `scflow/delete_transformation`. */
export interface DeleteTransformationParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_transformation_type`. */
export interface DeleteTransformationTypeParams {
  id: string;
  cascade?: boolean;
}

/** The result of `scflow/create_transformation_type`. */
export interface TransformationTypeSummary {
  id: string;
  display_name: Record<string, string>;
}

/** A transformation as the actions return it. */
export interface TransformationSummary {
  id: string;
  display_name: Record<string, string>;
  type: string;
  actor: string;
}

/** A transformation line as the actions return it. */
export interface TransformationLineSummary {
  id: string;
  transformation: string;
  held_item: string;
  role: string;
}

/** The result of `scflow/define_process`. */
export interface DefinedProcess {
  transformation: TransformationSummary;
  lines: TransformationLineSummary[];
}

/** Creates a transformation type; see `scflow/create_transformation_type` in `docs/actions.md`. */
export const createTransformationTypeAction: ScflowActionDefinition<
  CreateTransformationTypeParams,
  TransformationTypeSummary
> = {
  id: "scflow/create_transformation_type",
  writes: ["transformation_type"],
  title: "Create a transformation type",
  description:
    "Creates a transformation type, a kind of operation such as assembly, machining, packaging or inspection, and returns it.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the transformation type, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the transformation type."),
      tags: tagsParam("Tags of the transformation type."),
    },
    required: ["display_name"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { display_name: toLocalized(params.display_name) };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.transformation_type", input });
    const type = after[0] as unknown as Instance;
    return { id: type.id, display_name: type.display_name as Record<string, string> };
  },
};

/** Creates a transformation; see `scflow/create_transformation` in `docs/actions.md`. */
export const createTransformationAction: ScflowActionDefinition<CreateTransformationParams, TransformationSummary> = {
  id: "scflow/create_transformation",
  writes: ["transformation"],
  title: "Create a transformation",
  description:
    "Creates a transformation of a given type inside an actor, with no line yet, and returns it. " +
    "The transformation is named after its type when no name is given.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("actor", "Id or name of the actor that executes the transformation."),
      type: refParam("transformation_type", "Id or name of the transformation type."),
      display_name: localizedTextParam("Display name of the transformation; the name of its type when omitted."),
      description: localizedTextParam("Markdown description of the transformation."),
      tags: tagsParam("Tags of the transformation."),
    },
    required: ["actor", "type"],
    additionalProperties: false,
  },
  async run(params, context) {
    return insertTransformation(context, params.actor, params.type, {
      ...(params.display_name === undefined ? {} : { display_name: toLocalized(params.display_name) }),
      ...(params.description === undefined ? {} : { description: toLocalized(params.description) }),
      ...(params.tags === undefined ? {} : { tags: unique(params.tags) }),
    });
  },
};

/** Connects a held item to a transformation; see `scflow/connect_transformation_line` in `docs/actions.md`. */
export const connectTransformationLineAction: ScflowActionDefinition<
  ConnectTransformationLineParams,
  TransformationLineSummary
> = {
  id: "scflow/connect_transformation_line",
  writes: ["transformation_line"],
  title: "Connect a transformation line",
  description:
    "Connects an item held by the actor of a transformation to that transformation, as an input (consumed) or an output " +
    "(produced), and returns the line. When the same line exists, it is returned. Give the id of the held-item record.",
  parameters: {
    type: "object",
    properties: {
      transformation: refParam("transformation", "Id or name of the transformation."),
      held_item: refParam("item_at_actor", "Id of the item-at-actor record, held by the actor of the transformation."),
      role: { type: "string", enum: ["consumed", "produced"], description: "Whether the transformation consumes or produces the item." },
      tags: tagsParam("Tags of the line, when the action creates it."),
    },
    required: ["transformation", "held_item", "role"],
    additionalProperties: false,
  },
  async run(params, context) {
    return summarizeLine(await insertLine(context, params.transformation, params.held_item, params.role, unique(params.tags)));
  },
};

/** Defines a whole process in one step; see `scflow/define_process` in `docs/actions.md`. */
export const defineProcessAction: ScflowActionDefinition<DefineProcessParams, DefinedProcess> = {
  id: "scflow/define_process",
  writes: ["transformation", "item_at_actor", "transformation_line"],
  title: "Define a process",
  description:
    "Creates a transformation of a given type at an actor, makes the actor hold the consumed and produced items that it does not " +
    "hold yet, and attaches a line for each of them, in one step. Every item must be in a domain of the actor. " +
    "Returns the transformation and its lines.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("actor", "Id or name of the actor."),
      transformation_type: refParam("transformation_type", "Id or name of the transformation type."),
      consumed_items: {
        type: "array",
        items: { type: "string", ref: "item" },
        description: "Ids or names of the items consumed.",
      },
      produced_items: {
        type: "array",
        items: { type: "string", ref: "item" },
        description: "Ids or names of the items produced.",
      },
    },
    required: ["actor", "transformation_type"],
    additionalProperties: false,
  },
  async run(params, context) {
    const transformation = await insertTransformation(context, params.actor, params.transformation_type, {});
    const consumed = unique(params.consumed_items) ?? [];
    const produced = unique(params.produced_items) ?? [];
    const lines: TransformationLineSummary[] = [];
    for (const [role, items] of [
      ["consumed", consumed],
      ["produced", produced],
    ] as const) {
      for (const item of items) {
        const held = await holdItem(context, params.actor, item);
        lines.push(summarizeLine(await insertLine(context, transformation.id, held.id, role)));
      }
    }
    return { transformation, lines };
  },
};

/** Deletes a transformation; see `scflow/delete_transformation` in `docs/actions.md`. */
export const deleteTransformationAction: ScflowActionDefinition<DeleteTransformationParams, { id: string }> = {
  id: "scflow/delete_transformation",
  writes: ["transformation", "transformation_line"],
  destructive: true,
  title: "Delete a transformation",
  description:
    "Deletes a transformation with its lines and notes, and returns its id. The held items that its lines used are kept. " +
    "The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("transformation", "Id or name of the transformation to delete."),
      cascade: cascadeParam("Has no effect: the lines and the notes of a transformation are always deleted with it."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.transformation", params.id);
    return { id: params.id };
  },
};

/** Deletes a transformation type; see `scflow/delete_transformation_type` in `docs/actions.md`. */
export const deleteTransformationTypeAction: ScflowActionDefinition<DeleteTransformationTypeParams, { id: string }> = {
  id: "scflow/delete_transformation_type",
  writes: ["transformation", "transformation_line", "transformation_type"],
  destructive: true,
  title: "Delete a transformation type",
  description:
    "Deletes a transformation type. It is refused while transformations have this type, unless cascade is true, which deletes " +
    "those transformations first, with their lines and notes.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("transformation_type", "Id or name of the transformation type to delete."),
      cascade: cascadeParam("When true, also deletes the transformations of this type with their lines and notes."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.transformation_type", params.id, params.cascade);
    return { id: params.id };
  },
};

/** The actions of the lot transformations and processes, in catalog order. */
export const TRANSFORMATION_ACTIONS = [
  createTransformationTypeAction,
  createTransformationAction,
  connectTransformationLineAction,
  defineProcessAction,
  deleteTransformationAction,
  deleteTransformationTypeAction,
] as const;

/** Creates a transformation; the schema names it after its type unless a name is given. */
async function insertTransformation(
  context: ActionAccess,
  actor: string,
  type: string,
  extra: Record<string, unknown>,
): Promise<TransformationSummary> {
  const { after } = await context.runCommand(context.locator, {
    kind: "create",
    schema: "scflow.transformation",
    input: { ...extra, type, actor },
  });
  const transformation = after[0] as unknown as Instance;
  return {
    id: transformation.id,
    display_name: transformation.display_name as Record<string, string>,
    type: transformation.type as string,
    actor: transformation.actor as string,
  };
}

/** Returns the line of a transformation for a held item and a role, and creates it when it does not exist. */
async function insertLine(
  context: ActionAccess,
  transformation: string,
  heldItem: string,
  role: string,
  tags?: string[],
): Promise<Instance> {
  const existing = await context.runCommand(context.locator, {
    kind: "query",
    schema: "scflow.transformation_line",
    filters: { transformation, held_item: heldItem, role },
  });
  if (existing.after.length > 0) {
    return existing.after[0] as unknown as Instance;
  }
  const { after } = await context.runCommand(context.locator, {
    kind: "create",
    schema: "scflow.transformation_line",
    input: { transformation, held_item: heldItem, role, ...(tags === undefined ? {} : { tags }) },
  });
  return after[0] as unknown as Instance;
}

function summarizeLine(line: Instance): TransformationLineSummary {
  return {
    id: line.id,
    transformation: line.transformation as string,
    held_item: line.held_item as string,
    role: line.role as string,
  };
}

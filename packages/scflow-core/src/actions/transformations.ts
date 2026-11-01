import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";
import { deleteTransformations, loadSnapshot } from "./delete-impact.js";
import { assertHoldable, holdItem } from "./items.js";
import { localizedTextParam, optionalBoolean, optionalStringList, refParam, requireRole } from "./params.js";
import { labelOf, resolveRef, type Instance } from "./refs.js";
import { toLocalized } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_transformation_type`. */
export interface CreateTransformationTypeParams {
  name: Text;
  description?: Text;
}

/** Parameters of `scflow/create_transformation`. */
export interface CreateTransformationParams {
  actor: string;
  type: string;
  name?: Text;
}

/** Parameters of `scflow/connect_transformation_line`. */
export interface ConnectTransformationLineParams {
  transformation: string;
  held_item: string;
  role: "consumed" | "produced";
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
  transformation: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_transformation_type`. */
export interface DeleteTransformationTypeParams {
  type: string;
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
export const createTransformationTypeAction: ModelActionDefinition<
  CreateTransformationTypeParams,
  TransformationTypeSummary
> = {
  id: "scflow/create_transformation_type",
  title: "Create a transformation type",
  description:
    "Creates a transformation type, a kind of operation such as assembly, machining, packaging or inspection, and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Display name of the transformation type, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the transformation type."),
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const input: Record<string, unknown> = { display_name: toLocalized(params.name, "name") };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description, "description");
    }
    const { after } = await access.runCommand(locator, { kind: "create", schema: "transformation_type", input });
    const type = after[0] as unknown as Instance;
    return { id: type.id, display_name: type.display_name as Record<string, string> };
  },
};

/** Creates a transformation; see `scflow/create_transformation` in `docs/actions.md`. */
export const createTransformationAction: ModelActionDefinition<CreateTransformationParams, TransformationSummary> = {
  id: "scflow/create_transformation",
  title: "Create a transformation",
  description:
    "Creates a transformation of a given type inside an actor, with no line yet, and returns it. " +
    "The transformation is named after its type when no name is given.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("Id or name of the actor that executes the transformation."),
      type: refParam("Id or name of the transformation type."),
      name: localizedTextParam("Display name of the transformation; the name of its type when omitted."),
    },
    required: ["actor", "type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const actor = await resolveRef(access, locator, "actor", params.actor, "actor");
    const type = await resolveRef(access, locator, "transformation_type", params.type, "type");
    const name = params.name === undefined ? undefined : toLocalized(params.name, "name");
    return insertTransformation(access, locator, actor, type, name);
  },
};

/** Connects a held item to a transformation; see `scflow/connect_transformation_line` in `docs/actions.md`. */
export const connectTransformationLineAction: ModelActionDefinition<
  ConnectTransformationLineParams,
  TransformationLineSummary
> = {
  id: "scflow/connect_transformation_line",
  title: "Connect a transformation line",
  description:
    "Connects an item held by the actor of a transformation to that transformation, as an input (consumed) or an output " +
    "(produced), and returns the line. When the same line exists, it is returned. Give the id of the held-item record.",
  parameters: {
    type: "object",
    properties: {
      transformation: refParam("Id or name of the transformation."),
      held_item: refParam("Id of the item-at-actor record, held by the actor of the transformation."),
      role: { type: "string", enum: ["consumed", "produced"], description: "Whether the transformation consumes or produces the item." },
    },
    required: ["transformation", "held_item", "role"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const transformation = await resolveRef(access, locator, "transformation", params.transformation, "transformation");
    const held = await resolveRef(access, locator, "item_at_actor", params.held_item, "held_item");
    const role = requireRole(params.role, "role");

    if (held.actor !== transformation.actor) {
      const owner = await resolveRef(access, locator, "actor", held.actor, "held_item");
      const executor = await resolveRef(access, locator, "actor", transformation.actor, "transformation");
      throw new Error(
        `parameter "held_item": the record is held by "${labelOf(owner)}", not by "${labelOf(executor)}", the actor of the transformation`,
      );
    }
    return summarizeLine(await insertLine(access, locator, transformation.id, held.id, role));
  },
};

/** Defines a whole process in one step; see `scflow/define_process` in `docs/actions.md`. */
export const defineProcessAction: ModelActionDefinition<DefineProcessParams, DefinedProcess> = {
  id: "scflow/define_process",
  title: "Define a process",
  description:
    "Creates a transformation of a given type at an actor, makes the actor hold the consumed and produced items that it does not " +
    "hold yet, and attaches a line for each of them, in one step. Every item must be in a domain of the actor. " +
    "Returns the transformation and its lines.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("Id or name of the actor."),
      transformation_type: refParam("Id or name of the transformation type."),
      consumed_items: {
        type: "array",
        items: { type: "string" },
        description: "Ids or names of the items consumed.",
      },
      produced_items: {
        type: "array",
        items: { type: "string" },
        description: "Ids or names of the items produced.",
      },
    },
    required: ["actor", "transformation_type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const actor = await resolveRef(access, locator, "actor", params.actor, "actor");
    const type = await resolveRef(
      access,
      locator,
      "transformation_type",
      params.transformation_type,
      "transformation_type",
    );
    const consumed = await resolveItems(access, locator, params.consumed_items, "consumed_items");
    const produced = await resolveItems(access, locator, params.produced_items, "produced_items");

    for (const [param, items] of [
      ["consumed_items", consumed],
      ["produced_items", produced],
    ] as const) {
      for (const item of items) {
        await assertHoldable(access, locator, actor, item, param);
      }
    }

    const transformation = await insertTransformation(access, locator, actor, type, undefined);
    const lines: TransformationLineSummary[] = [];
    for (const [role, items] of [
      ["consumed", consumed],
      ["produced", produced],
    ] as const) {
      for (const item of items) {
        const held = await holdItem(access, locator, actor, item);
        lines.push(summarizeLine(await insertLine(access, locator, transformation.id, held.id, role)));
      }
    }
    return { transformation, lines };
  },
};

/** Deletes a transformation; see `scflow/delete_transformation` in `docs/actions.md`. */
export const deleteTransformationAction: ModelActionDefinition<DeleteTransformationParams, { id: string }> = {
  id: "scflow/delete_transformation",
  title: "Delete a transformation",
  description:
    "Deletes a transformation with its lines and notes, and returns its id. The held items that its lines used are kept. " +
    "The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      transformation: refParam("Id or name of the transformation to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description: "Has no effect: the lines and the notes of a transformation are always deleted with it.",
      },
    },
    required: ["transformation"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const transformation = await resolveRef(access, locator, "transformation", params.transformation, "transformation");
    optionalBoolean(params.cascade, "cascade");
    const snapshot = await loadSnapshot(access, locator);

    await deleteTransformations(access, locator, snapshot, [transformation.id]);
    return { id: transformation.id };
  },
};

/** Deletes a transformation type; see `scflow/delete_transformation_type` in `docs/actions.md`. */
export const deleteTransformationTypeAction: ModelActionDefinition<DeleteTransformationTypeParams, { id: string }> = {
  id: "scflow/delete_transformation_type",
  title: "Delete a transformation type",
  description:
    "Deletes a transformation type. It is refused while transformations have this type, unless cascade is true, which deletes " +
    "those transformations first, with their lines and notes.",
  parameters: {
    type: "object",
    properties: {
      type: refParam("Id or name of the transformation type to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description: "When true, also deletes the transformations of this type with their lines and notes.",
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const type = await resolveRef(access, locator, "transformation_type", params.type, "type");
    const cascade = optionalBoolean(params.cascade, "cascade") ?? false;
    const snapshot = await loadSnapshot(access, locator);
    const transformations = snapshot.transformations.filter((transformation) => transformation.type === type.id);

    if (transformations.length > 0 && !cascade) {
      throw new Error(
        `parameter "type": "${labelOf(type)}" is used by ${transformations.length} transformation(s); use cascade: true to delete them`,
      );
    }
    await deleteTransformations(access, locator, snapshot, transformations.map((transformation) => transformation.id));
    await access.runCommand(locator, { kind: "delete", schema: "transformation_type", filters: { id: type.id } });
    return { id: type.id };
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

/** Creates a transformation, named after its type unless a name is given. */
async function insertTransformation(
  access: MclAccess,
  locator: string,
  actor: Instance,
  type: Instance,
  name: Record<string, string> | undefined,
): Promise<TransformationSummary> {
  const { after } = await access.runCommand(locator, {
    kind: "create",
    schema: "transformation",
    input: { display_name: name ?? { ...(type.display_name as Record<string, string>) }, type: type.id, actor: actor.id },
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
  access: MclAccess,
  locator: string,
  transformation: string,
  heldItem: string,
  role: string,
): Promise<Instance> {
  const existing = await access.runCommand(locator, {
    kind: "query",
    schema: "transformation_line",
    filters: { transformation, held_item: heldItem, role },
  });
  if (existing.after.length > 0) {
    return existing.after[0] as unknown as Instance;
  }
  const { after } = await access.runCommand(locator, {
    kind: "create",
    schema: "transformation_line",
    input: { transformation, held_item: heldItem, role },
  });
  return after[0] as unknown as Instance;
}

/** Resolves a list of item references to distinct items, in the order given. */
async function resolveItems(
  access: MclAccess,
  locator: string,
  refs: unknown,
  param: string,
): Promise<Instance[]> {
  const list = optionalStringList(refs, param) ?? [];
  const items: Instance[] = [];
  for (const ref of list) {
    const item = await resolveRef(access, locator, "item", ref, param);
    if (!items.some((known) => known.id === item.id)) {
      items.push(item);
    }
  }
  return items;
}

function summarizeLine(line: Instance): TransformationLineSummary {
  return {
    id: line.id,
    transformation: line.transformation as string,
    held_item: line.held_item as string,
    role: line.role as string,
  };
}

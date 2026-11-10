import { type Instance } from "./refs.js";
import { type ActionAccess, type ScflowActionDefinition, localizedTextParam, cascadeParam, refParam, tagsParam, unique } from "./params.js";
import { deleteById } from "./delete-impact.js";
import { localizedText } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_item_type`. */
export interface CreateItemTypeParams {
  display_name: Text;
  domain: string;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/create_item`. */
export interface CreateItemParams {
  display_name: Text;
  type: string;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/update_item`. */
export interface UpdateItemParams {
  id: string;
  display_name?: Text;
  description?: Text;
  type?: string;
  tags?: string[];
}

/** Parameters of `scflow/hold_item`. */
export interface HoldItemParams {
  actor: string;
  item: string;
  tags?: string[];
}

/** Parameters of `scflow/release_held_item`. */
export interface ReleaseHeldItemParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_item`. */
export interface DeleteItemParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_item_type`. */
export interface DeleteItemTypeParams {
  id: string;
  cascade?: boolean;
}

/** The result of `scflow/create_item_type`. */
export interface ItemTypeSummary {
  id: string;
  display_name: Record<string, string>;
  domain: string;
}

/** The result of `scflow/create_item`. */
export interface ItemSummary {
  id: string;
  display_name: Record<string, string>;
  type: string;
}

/** The result of `scflow/hold_item`: an item held by an actor. */
export interface HeldItemSummary {
  id: string;
  actor: string;
  item: string;
}

/** Creates an item type; see `scflow/create_item_type` in `docs/actions.md`. */
export const createItemTypeAction: ScflowActionDefinition<CreateItemTypeParams, ItemTypeSummary> = {
  id: "scflow/create_item_type",
  writes: ["item_type"],
  title: "Create an item type",
  description:
    "Creates an item type, a category of items bound to one flow domain (physical, information, financial or service), and returns it.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the item type, a string or a map of language to string."),
      domain: {
        type: "string",
        enum: ["physical", "information", "financial", "service"],
        description: "The flow domain of the items of this type.",
      },
      description: localizedTextParam("Markdown description of the item type."),
      tags: tagsParam("Tags of the item type."),
    },
    required: ["display_name", "domain"],
    additionalProperties: false,
  },
  async run(params, context) {
    const display_name = await localizedText(context, params.display_name);
    const domain = params.domain;
    const input: Record<string, unknown> = { display_name, domain };
    if (params.description !== undefined) {
      input.description = await localizedText(context, params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.item_type", input });
    const type = after[0] as unknown as Instance;
    return { id: type.id, display_name: type.display_name as Record<string, string>, domain: type.domain as string };
  },
};

/** Creates an item; see `scflow/create_item` in `docs/actions.md`. */
export const createItemAction: ScflowActionDefinition<CreateItemParams, ItemSummary> = {
  id: "scflow/create_item",
  writes: ["item"],
  title: "Create an item",
  description: "Creates an item, a family of things the network moves and holds, of a given item type, and returns it.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the item, a string or a map of language to string."),
      type: refParam("item_type", "Id or name of the item type."),
      description: localizedTextParam("Markdown description of the item."),
      tags: tagsParam("Tags of the item."),
    },
    required: ["display_name", "type"],
    additionalProperties: false,
  },
  async run(params, context) {
    const display_name = await localizedText(context, params.display_name);
    const input: Record<string, unknown> = { display_name, type: params.type };
    if (params.description !== undefined) {
      input.description = await localizedText(context, params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.item", input });
    const item = after[0] as unknown as Instance;
    return { id: item.id, display_name: item.display_name as Record<string, string>, type: item.type as string };
  },
};

/** Updates an item; see `scflow/update_item` in `docs/actions.md`. */
export const updateItemAction: ScflowActionDefinition<UpdateItemParams, ItemSummary> = {
  id: "scflow/update_item",
  writes: ["item"],
  title: "Update an item",
  description:
    "Changes the name, description or type of an item and returns it. Only the given properties change. " +
    "A change of type that breaks a rule on the held records of the item or the flows that carry it is refused.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("item", "Id or name of the item to update."),
      display_name: localizedTextParam("New display name; each given language replaces the same language, the others are kept."),
      description: localizedTextParam("New Markdown description; same language rule as name."),
      type: refParam("item_type", "Id or name of the new item type."),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const patch: Record<string, unknown> = {};

    if (params.display_name !== undefined) {
      patch.display_name = { set: await localizedText(context, params.display_name) };
    }
    if (params.description !== undefined) {
      patch.description = { set: await localizedText(context, params.description) };
    }
    if (params.type !== undefined) {
      patch.type = params.type;
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      patch.tags = tags;
    }

    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.item",
      filters: { id: params.id },
      input: patch,
    });
    const updated = after[0] as unknown as Instance;
    return {
      id: updated.id,
      display_name: updated.display_name as Record<string, string>,
      type: updated.type as string,
    };
  },
};

/** Makes an actor hold an item; see `scflow/hold_item` in `docs/actions.md`. */
export const holdItemAction: ScflowActionDefinition<HoldItemParams, HeldItemSummary> = {
  id: "scflow/hold_item",
  writes: ["item_at_actor"],
  title: "Hold an item at an actor",
  description:
    "Makes an actor hold an item (inventory, queue, cash or backlog) and returns the record. The domain of the item must be " +
    "among the domains of the actor. When the actor already holds the item, the existing record is returned.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("actor", "Id or name of the actor."),
      item: refParam("item", "Id or name of the item."),
      tags: tagsParam("Tags of the record, when the action creates it."),
    },
    required: ["actor", "item"],
    additionalProperties: false,
  },
  async run(params, context) {
    return summarizeHeld(await holdItem(context, params.actor, params.item, unique(params.tags)));
  },
};

/** Removes an item from an actor; see `scflow/release_held_item` in `docs/actions.md`. */
export const releaseHeldItemAction: ScflowActionDefinition<ReleaseHeldItemParams, { id: string }> = {
  id: "scflow/release_held_item",
  writes: ["item_at_actor", "transformation_line"],
  destructive: true,
  title: "Release a held item",
  description:
    "Removes an item from the actor that holds it, and returns the id of the removed record. It is refused while a " +
    "transformation line uses the record, unless cascade is true, which deletes those lines first. Give the id of the record returned by hold_item.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("item_at_actor", "Id of the item-at-actor record to remove."),
      cascade: cascadeParam("When true, also deletes the transformation lines that use the record."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.item_at_actor", params.id, params.cascade);
    return { id: params.id };
  },
};

/** Deletes an item; see `scflow/delete_item` in `docs/actions.md`. */
export const deleteItemAction: ScflowActionDefinition<DeleteItemParams, { id: string }> = {
  id: "scflow/delete_item",
  writes: ["item", "flow", "item_at_actor", "transformation_line", "conversion"],
  destructive: true,
  title: "Delete an item",
  description:
    "Deletes an item. It is refused while actors hold it, flows carry it or conversions reference it, unless cascade is true, which " +
    "deletes the held records, the flows that carry it and the conversions first, with the transformation lines that use the held " +
    "records and the notes of every deleted entity.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("item", "Id or name of the item to delete."),
      cascade: cascadeParam("When true, also deletes the held records, the flows that carry the item, the conversions, the transformation lines and the notes."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.item", params.id, params.cascade);
    return { id: params.id };
  },
};

/** Deletes an item type; see `scflow/delete_item_type` in `docs/actions.md`. */
export const deleteItemTypeAction: ScflowActionDefinition<DeleteItemTypeParams, { id: string }> = {
  id: "scflow/delete_item_type",
  writes: ["item", "item_type", "flow", "item_at_actor", "transformation_line", "conversion"],
  destructive: true,
  title: "Delete an item type",
  description:
    "Deletes an item type. It is refused while items have this type, unless cascade is true, which deletes those items first, " +
    "each with the cascade of scflow/delete_item.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("item_type", "Id or name of the item type to delete."),
      cascade: cascadeParam("When true, also deletes the items of this type with their held records, flows, lines and notes."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.item_type", params.id, params.cascade);
    return { id: params.id };
  },
};

/** The actions of the lot items and inventory, in catalog order. */
export const ITEM_ACTIONS = [
  createItemTypeAction,
  createItemAction,
  updateItemAction,
  holdItemAction,
  releaseHeldItemAction,
  deleteItemAction,
  deleteItemTypeAction,
] as const;

/**
 * Returns the `item_at_actor` record of an actor and an item, and creates it when the
 * actor does not hold the item yet. The engine refuses a breach of the rules of the record.
 */
export async function holdItem(context: ActionAccess, actor: string, item: string, tags?: string[]): Promise<Instance> {
  const existing = await context.runCommand(context.locator, {
    kind: "query",
    schema: "scflow.item_at_actor",
    filters: { actor, item },
  });
  if (existing.after.length > 0) {
    return existing.after[0] as unknown as Instance;
  }
  const { after } = await context.runCommand(context.locator, {
    kind: "create",
    schema: "scflow.item_at_actor",
    input: { actor, item, ...(tags === undefined ? {} : { tags }) },
  });
  return after[0] as unknown as Instance;
}

function summarizeHeld(record: Instance): HeldItemSummary {
  return { id: record.id, actor: record.actor as string, item: record.item as string };
}

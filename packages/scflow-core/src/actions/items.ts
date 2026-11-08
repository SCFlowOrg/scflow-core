import { labelOf, loadInstance, type Instance } from "./refs.js";
import { type ActionAccess, type ScflowActionDefinition, localizedTextParam, cascadeParam, refParam, tagsParam, unique } from "./params.js";
import { deleteItems, loadSnapshot } from "./delete-impact.js";
import { toLocalized } from "./text.js";

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
    const display_name = toLocalized(params.display_name);
    const domain = params.domain;
    const input: Record<string, unknown> = { display_name, domain };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description);
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
    const display_name = toLocalized(params.display_name);
    const input: Record<string, unknown> = { display_name, type: params.type };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description);
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
    "Changing the type does not check the held records of the item and the flows that carry it: the network check reports " +
    "the ones whose domain no longer fits.",
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
      patch.display_name = { set: toLocalized(params.display_name) };
    }
    if (params.description !== undefined) {
      patch.description = { set: toLocalized(params.description) };
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
    const actor = await loadInstance(context, "scflow.actor", params.actor);
    const item = await loadInstance(context, "scflow.item", params.item);

    await assertHoldable(context, actor, item, "item");
    return summarizeHeld(await holdItem(context, actor, item, unique(params.tags)));
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
    const held = await loadInstance(context, "scflow.item_at_actor", params.id);
    const lines = await context.runCommand(context.locator, {
      kind: "query",
      schema: "scflow.transformation_line",
      filters: { held_item: held.id },
    });
    if (lines.after.length > 0 && params.cascade !== true) {
      throw new Error(
        `parameter "id": the record is used by ${lines.after.length} transformation line(s); remove them first or use cascade: true`,
      );
    }
    if (lines.after.length > 0) {
      await context.runCommand(context.locator, { kind: "delete", schema: "scflow.transformation_line", filters: { held_item: held.id } });
    }
    await context.runCommand(context.locator, { kind: "delete", schema: "scflow.item_at_actor", filters: { id: held.id } });
    return { id: held.id };
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
    const item = await loadInstance(context, "scflow.item", params.id);
    const cascade = params.cascade === true;
    const snapshot = await loadSnapshot(context);

    if (!cascade) {
      const references = [
        [snapshot.held.filter((record) => record.item === item.id).length, "held item"],
        [snapshot.flows.filter((flow) => flow.item === item.id).length, "flow"],
        [
          snapshot.conversions.filter(
            (conversion) => conversion.from_item === item.id || conversion.to_item === item.id,
          ).length,
          "conversion",
        ],
      ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, what]) => `${n} ${what}(s)`);
      if (references.length > 0) {
        throw new Error(
          `parameter "id": "${labelOf(item)}" is still used by ${references.join(", ")}; use cascade: true to delete them`,
        );
      }
    }
    await deleteItems(context, snapshot, [item.id]);
    return { id: item.id };
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
    const type = await loadInstance(context, "scflow.item_type", params.id);
    const cascade = params.cascade === true;
    const snapshot = await loadSnapshot(context);
    const items = snapshot.items.filter((item) => item.type === type.id);

    if (items.length > 0 && !cascade) {
      throw new Error(
        `parameter "id": "${labelOf(type)}" is used by ${items.length} item(s); use cascade: true to delete them`,
      );
    }
    await deleteItems(context, snapshot, items.map((item) => item.id));
    await context.runCommand(context.locator, { kind: "delete", schema: "scflow.item_type", filters: { id: type.id } });
    return { id: type.id };
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
 * Checks that an actor can hold an item: the domain of the item, which is the
 * domain of its type, is among the domains of the type of the actor.
 *
 * @param param The name of the parameter that gave the item, quoted in the error message.
 * @throws When the domain of the item is not among the domains of the actor.
 */
export async function assertHoldable(
  context: ActionAccess,
  actor: Instance,
  item: Instance,
  param: string,
): Promise<void> {
  const domain = await domainOfItem(context, item);
  const actorType = await loadInstance(context, "scflow.actor_type", actor.type);
  const actorDomains = actorType.domains as string[];
  if (!actorDomains.includes(domain)) {
    throw new Error(
      `parameter "${param}": "${labelOf(item)}" is in the ${domain} domain, which is not among the domains of "${labelOf(actor)}" (${actorDomains.join(", ")})`,
    );
  }
}

/**
 * Checks that a flow can carry an item: the domain of the item, which is the
 * domain of its type, is among the domains of the type of the source actor and
 * among the domains of the type of the destination actor of the flow.
 *
 * @param source The source actor of the flow.
 * @param destination The destination actor of the flow.
 * @throws When the domain of the item is not among the domains of an end of the flow.
 */
export async function assertCarryable(
  context: ActionAccess,
  source: Instance,
  destination: Instance,
  item: Instance,
): Promise<void> {
  const domain = await domainOfItem(context, item);
  for (const [role, actor] of [
    ["source", source],
    ["destination", destination],
  ] as const) {
    const actorType = await loadInstance(context, "scflow.actor_type", actor.type);
    const actorDomains = actorType.domains as string[];
    if (!actorDomains.includes(domain)) {
      throw new Error(
        `parameter "item": "${labelOf(item)}" is in the ${domain} domain, which is not among the domains of the ${role} "${labelOf(actor)}" of the flow (${actorDomains.join(", ")})`,
      );
    }
  }
}

/**
 * Returns the `item_at_actor` record of an actor and an item, and creates it when the
 * actor does not hold the item yet. It checks nothing: call {@link assertHoldable} first.
 */
export async function holdItem(context: ActionAccess, actor: Instance, item: Instance, tags?: string[]): Promise<Instance> {
  const existing = await context.runCommand(context.locator, {
    kind: "query",
    schema: "scflow.item_at_actor",
    filters: { actor: actor.id, item: item.id },
  });
  if (existing.after.length > 0) {
    return existing.after[0] as unknown as Instance;
  }
  const { after } = await context.runCommand(context.locator, {
    kind: "create",
    schema: "scflow.item_at_actor",
    input: { actor: actor.id, item: item.id, ...(tags === undefined ? {} : { tags }) },
  });
  return after[0] as unknown as Instance;
}

/** The flow domain of an item, which is the domain of its type. */
export async function domainOfItem(context: ActionAccess, item: Instance): Promise<string> {
  const type = await loadInstance(context, "scflow.item_type", item.type);
  return type.domain as string;
}

function summarizeHeld(record: Instance): HeldItemSummary {
  return { id: record.id, actor: record.actor as string, item: record.item as string };
}

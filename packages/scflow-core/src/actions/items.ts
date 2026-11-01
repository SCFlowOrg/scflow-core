import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";
import { deleteItems, loadSnapshot } from "./delete-impact.js";
import {
  localizedTextParam,
  optionalBoolean,
  optionalStringList,
  refParam,
  requireDomain,
  tagsParam,
} from "./params.js";
import { labelOf, resolveRef, type Instance } from "./refs.js";
import { toLocalized } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_item_type`. */
export interface CreateItemTypeParams {
  name: Text;
  domain: string;
  description?: Text;
}

/** Parameters of `scflow/create_item`. */
export interface CreateItemParams {
  name: Text;
  type: string;
  tags?: string[];
}

/** Parameters of `scflow/update_item`. */
export interface UpdateItemParams {
  item: string;
  name?: Text;
  description?: Text;
  type?: string;
}

/** Parameters of `scflow/hold_item`. */
export interface HoldItemParams {
  actor: string;
  item: string;
}

/** Parameters of `scflow/release_held_item`. */
export interface ReleaseHeldItemParams {
  item_at_actor: string;
}

/** Parameters of `scflow/delete_item`. */
export interface DeleteItemParams {
  item: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_item_type`. */
export interface DeleteItemTypeParams {
  type: string;
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
export const createItemTypeAction: ModelActionDefinition<CreateItemTypeParams, ItemTypeSummary> = {
  id: "scflow/create_item_type",
  title: "Create an item type",
  description:
    "Creates an item type, a category of items bound to one flow domain (physical, information, financial or service), and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Display name of the item type, a string or a map of language to string."),
      domain: {
        type: "string",
        enum: ["physical", "information", "financial", "service"],
        description: "The flow domain of the items of this type.",
      },
      description: localizedTextParam("Markdown description of the item type."),
    },
    required: ["name", "domain"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const display_name = toLocalized(params.name, "name");
    const domain = requireDomain(params.domain, "domain");
    const input: Record<string, unknown> = { display_name, domain };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description, "description");
    }
    const { after } = await access.runCommand(locator, { kind: "create", schema: "item_type", input });
    const type = after[0] as unknown as Instance;
    return { id: type.id, display_name: type.display_name as Record<string, string>, domain: type.domain as string };
  },
};

/** Creates an item; see `scflow/create_item` in `docs/actions.md`. */
export const createItemAction: ModelActionDefinition<CreateItemParams, ItemSummary> = {
  id: "scflow/create_item",
  title: "Create an item",
  description: "Creates an item, a family of things the network moves and holds, of a given item type, and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Display name of the item, a string or a map of language to string."),
      type: refParam("Id or name of the item type."),
      tags: tagsParam("Tags of the item."),
    },
    required: ["name", "type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const display_name = toLocalized(params.name, "name");
    const type = await resolveRef(access, locator, "item_type", params.type, "type");
    const input: Record<string, unknown> = { display_name, type: type.id };
    const tags = optionalStringList(params.tags, "tags");
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await access.runCommand(locator, { kind: "create", schema: "item", input });
    const item = after[0] as unknown as Instance;
    return { id: item.id, display_name: item.display_name as Record<string, string>, type: item.type as string };
  },
};

/** Updates an item; see `scflow/update_item` in `docs/actions.md`. */
export const updateItemAction: ModelActionDefinition<UpdateItemParams, ItemSummary> = {
  id: "scflow/update_item",
  title: "Update an item",
  description:
    "Changes the name, description or type of an item and returns it. Only the given properties change. " +
    "Changing the type does not check the held records of the item and the flows that carry it: the network check reports " +
    "the ones whose domain no longer fits.",
  parameters: {
    type: "object",
    properties: {
      item: refParam("Id or name of the item to update."),
      name: localizedTextParam("New display name; each given language replaces the same language, the others are kept."),
      description: localizedTextParam("New Markdown description; same language rule as name."),
      type: refParam("Id or name of the new item type."),
    },
    required: ["item"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const item = await resolveRef(access, locator, "item", params.item, "item");
    const patch: Record<string, unknown> = {};

    if (params.name !== undefined) {
      patch.display_name = { set: toLocalized(params.name, "name") };
    }
    if (params.description !== undefined) {
      patch.description = { set: toLocalized(params.description, "description") };
    }
    if (params.type !== undefined) {
      patch.type = (await resolveRef(access, locator, "item_type", params.type, "type")).id;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('scflow/update_item: give at least one property to change besides "item" (name, description, type)');
    }

    const { after } = await access.runCommand(locator, {
      kind: "update",
      schema: "item",
      filters: { id: item.id },
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
export const holdItemAction: ModelActionDefinition<HoldItemParams, HeldItemSummary> = {
  id: "scflow/hold_item",
  title: "Hold an item at an actor",
  description:
    "Makes an actor hold an item (inventory, queue, cash or backlog) and returns the record. The domain of the item must be " +
    "among the domains of the actor. When the actor already holds the item, the existing record is returned.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("Id or name of the actor."),
      item: refParam("Id or name of the item."),
    },
    required: ["actor", "item"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const actor = await resolveRef(access, locator, "actor", params.actor, "actor");
    const item = await resolveRef(access, locator, "item", params.item, "item");

    await assertHoldable(access, locator, actor, item, "item");
    return summarizeHeld(await holdItem(access, locator, actor, item));
  },
};

/** Removes an item from an actor; see `scflow/release_held_item` in `docs/actions.md`. */
export const releaseHeldItemAction: ModelActionDefinition<ReleaseHeldItemParams, { id: string }> = {
  id: "scflow/release_held_item",
  title: "Release a held item",
  description:
    "Removes an item from the actor that holds it, and returns the id of the removed record. It is refused while a " +
    "transformation line uses the record. Give the id of the record returned by hold_item.",
  parameters: {
    type: "object",
    properties: {
      item_at_actor: refParam("Id of the item-at-actor record to remove."),
    },
    required: ["item_at_actor"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const held = await resolveRef(access, locator, "item_at_actor", params.item_at_actor, "item_at_actor");
    const lines = await access.runCommand(locator, {
      kind: "query",
      schema: "transformation_line",
      filters: { held_item: held.id },
    });
    if (lines.after.length > 0) {
      throw new Error(
        `parameter "item_at_actor": the record is used by ${lines.after.length} transformation line(s); remove them first`,
      );
    }
    await access.runCommand(locator, { kind: "delete", schema: "item_at_actor", filters: { id: held.id } });
    return { id: held.id };
  },
};

/** Deletes an item; see `scflow/delete_item` in `docs/actions.md`. */
export const deleteItemAction: ModelActionDefinition<DeleteItemParams, { id: string }> = {
  id: "scflow/delete_item",
  title: "Delete an item",
  description:
    "Deletes an item. It is refused while actors hold it, flows carry it or conversions reference it, unless cascade is true, which " +
    "deletes the held records, the flows that carry it and the conversions first, with the transformation lines that use the held " +
    "records and the notes of every deleted entity.",
  parameters: {
    type: "object",
    properties: {
      item: refParam("Id or name of the item to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description:
          "When true, also deletes the held records, the flows that carry the item, the conversions, the transformation lines and the notes.",
      },
    },
    required: ["item"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const item = await resolveRef(access, locator, "item", params.item, "item");
    const cascade = optionalBoolean(params.cascade, "cascade") ?? false;
    const snapshot = await loadSnapshot(access, locator);

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
          `parameter "item": "${labelOf(item)}" is still used by ${references.join(", ")}; use cascade: true to delete them`,
        );
      }
    }
    await deleteItems(access, locator, snapshot, [item.id]);
    return { id: item.id };
  },
};

/** Deletes an item type; see `scflow/delete_item_type` in `docs/actions.md`. */
export const deleteItemTypeAction: ModelActionDefinition<DeleteItemTypeParams, { id: string }> = {
  id: "scflow/delete_item_type",
  title: "Delete an item type",
  description:
    "Deletes an item type. It is refused while items have this type, unless cascade is true, which deletes those items first, " +
    "each with the cascade of scflow/delete_item.",
  parameters: {
    type: "object",
    properties: {
      type: refParam("Id or name of the item type to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description: "When true, also deletes the items of this type with their held records, flows, lines and notes.",
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const type = await resolveRef(access, locator, "item_type", params.type, "type");
    const cascade = optionalBoolean(params.cascade, "cascade") ?? false;
    const snapshot = await loadSnapshot(access, locator);
    const items = snapshot.items.filter((item) => item.type === type.id);

    if (items.length > 0 && !cascade) {
      throw new Error(
        `parameter "type": "${labelOf(type)}" is used by ${items.length} item(s); use cascade: true to delete them`,
      );
    }
    await deleteItems(access, locator, snapshot, items.map((item) => item.id));
    await access.runCommand(locator, { kind: "delete", schema: "item_type", filters: { id: type.id } });
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
  access: MclAccess,
  locator: string,
  actor: Instance,
  item: Instance,
  param: string,
): Promise<void> {
  const domain = await domainOfItem(access, locator, item);
  const actorType = await resolveRef(access, locator, "actor_type", actor.type, "actor");
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
  access: MclAccess,
  locator: string,
  source: Instance,
  destination: Instance,
  item: Instance,
): Promise<void> {
  const domain = await domainOfItem(access, locator, item);
  for (const [role, actor] of [
    ["source", source],
    ["destination", destination],
  ] as const) {
    const actorType = await resolveRef(access, locator, "actor_type", actor.type, "flow");
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
export async function holdItem(access: MclAccess, locator: string, actor: Instance, item: Instance): Promise<Instance> {
  const existing = await access.runCommand(locator, {
    kind: "query",
    schema: "item_at_actor",
    filters: { actor: actor.id, item: item.id },
  });
  if (existing.after.length > 0) {
    return existing.after[0] as unknown as Instance;
  }
  const { after } = await access.runCommand(locator, {
    kind: "create",
    schema: "item_at_actor",
    input: { actor: actor.id, item: item.id },
  });
  return after[0] as unknown as Instance;
}

/** The flow domain of an item, which is the domain of its type. */
export async function domainOfItem(access: MclAccess, locator: string, item: Instance): Promise<string> {
  const type = await resolveRef(access, locator, "item_type", item.type, "item");
  return type.domain as string;
}

function summarizeHeld(record: Instance): HeldItemSummary {
  return { id: record.id, actor: record.actor as string, item: record.item as string };
}

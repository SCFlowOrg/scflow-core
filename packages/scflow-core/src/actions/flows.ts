import type { ModelActionDefinition } from "@scfloworg/core";
import { createFlow, setFlowItem } from "../flows.js";
import {
  localizedTextParam,
  nullableLocalizedTextParam,
  optionalBoolean,
  optionalStringList,
  refParam,
  tagsParam,
} from "./params.js";
import { resolveRef, type Instance } from "./refs.js";
import { toLocalized } from "./text.js";

/** Parameters of `scflow/create_flow`. */
export interface CreateFlowParams {
  source: string;
  destination: string;
  item?: string;
  bidirectional?: boolean;
  name?: string | Record<string, string>;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/set_flow_item`. */
export interface SetFlowItemParams {
  flow: string;
  item: string;
}

/** Parameters of `scflow/update_flow`. */
export interface UpdateFlowParams {
  flow: string;
  name?: string | Record<string, string> | null;
  bidirectional?: boolean;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/delete_flow`. */
export interface DeleteFlowParams {
  flow: string;
}

/** A flow as `scflow/create_flow` returns it; `display_name` is absent when the flow has no name, and `item` when it carries none. */
export interface FlowSummary {
  id: string;
  display_name?: Record<string, string>;
  source: string;
  destination: string;
  item?: string;
  bidirectional: boolean;
}

/** Creates a flow between two actors; see `scflow/create_flow` in `docs/actions.md`. */
export const createFlowAction: ModelActionDefinition<CreateFlowParams, FlowSummary> = {
  id: "scflow/create_flow",
  title: "Create a flow",
  description:
    "Creates a flow from a source actor to a destination actor and returns it. " +
    "Set bidirectional to true so that the flow carries items in both directions; it is one-way otherwise. " +
    "Give name to name the flow; it has no name otherwise. " +
    "A flow carries at most one item, given by item. A flow between an actor and one of its child actors, in either direction, " +
    "must carry an item, otherwise the action fails. The domain of the item must be among the domains of both actors, " +
    "and the actors that do not hold the item yet hold it afterwards.",
  parameters: {
    type: "object",
    properties: {
      source: refParam("Id or name of the actor the flow starts from."),
      destination: refParam("Id or name of the actor the flow arrives at."),
      item: refParam("Id or name of the item the flow carries; required between an actor and its child."),
      bidirectional: {
        type: "boolean",
        description: "Whether the flow carries items in both directions; false when omitted.",
      },
      name: localizedTextParam(
        "Display name of the flow, a string or a map of language to string; the flow has no name when omitted.",
      ),
      description: localizedTextParam("Markdown description of the flow."),
      tags: tagsParam("Tags of the flow."),
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const source = await resolveRef(access, locator, "actor", params.source, "source");
    const destination = await resolveRef(access, locator, "actor", params.destination, "destination");
    const item = params.item === undefined ? undefined : await resolveRef(access, locator, "item", params.item, "item");
    const bidirectional = optionalBoolean(params.bidirectional, "bidirectional");
    const display_name = params.name === undefined ? undefined : toLocalized(params.name, "name");
    const description = params.description === undefined ? undefined : toLocalized(params.description, "description");
    const tags = optionalStringList(params.tags, "tags");

    const flow = await createFlow(access, locator, {
      source: source.id,
      destination: destination.id,
      ...(item === undefined ? {} : { item: item.id }),
      ...(bidirectional === undefined ? {} : { bidirectional }),
      ...(display_name === undefined ? {} : { display_name }),
      ...(description === undefined ? {} : { description }),
      ...(tags === undefined ? {} : { tags }),
    });
    return summarizeFlow(flow as unknown as Instance);
  },
};

/** Sets the item of a flow; see `scflow/set_flow_item` in `docs/actions.md`. */
export const setFlowItemAction: ModelActionDefinition<SetFlowItemParams, FlowSummary> = {
  id: "scflow/set_flow_item",
  title: "Set the item of a flow",
  description:
    "Sets the item carried by a flow that carries none, and returns the flow. The item of a flow never changes and is never removed: " +
    "the action fails when the flow carries another item, and changes nothing when it already carries this one. " +
    "The domain of the item must be among the domains of both the source and the destination, and the actors that do not hold " +
    "the item yet hold it afterwards. A flow has no name: give its id.",
  parameters: {
    type: "object",
    properties: {
      flow: refParam("Id of the flow."),
      item: refParam("Id or name of the item."),
    },
    required: ["flow", "item"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const flow = await resolveRef(access, locator, "flow", params.flow, "flow");
    const item = await resolveRef(access, locator, "item", params.item, "item");
    return summarizeFlow((await setFlowItem(access, locator, { flow: flow.id, item: item.id })) as unknown as Instance);
  },
};

/** Updates a flow; see `scflow/update_flow` in `docs/actions.md`. */
export const updateFlowAction: ModelActionDefinition<UpdateFlowParams, FlowSummary> = {
  id: "scflow/update_flow",
  title: "Update a flow",
  description:
    "Changes the name, the bidirectional flag, the description or the tags of a flow and returns it. Only the given properties change; " +
    "null removes the name. " +
    "The source and the destination of a flow never change: delete the flow and create it again.",
  parameters: {
    type: "object",
    properties: {
      flow: refParam("Id of the flow to update."),
      name: nullableLocalizedTextParam(
        "New display name; each given language replaces the same language, the others are kept. null removes the name.",
      ),
      bidirectional: {
        type: "boolean",
        description: "Whether the flow carries items in both directions.",
      },
      description: localizedTextParam("New Markdown description; each given language replaces the same language, the others are kept."),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["flow"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const flow = await resolveRef(access, locator, "flow", params.flow, "flow");
    const patch: Record<string, unknown> = {};

    if (params.name !== undefined) {
      patch.display_name = params.name === null ? null : { set: toLocalized(params.name, "name") };
    }
    const bidirectional = optionalBoolean(params.bidirectional, "bidirectional");
    if (bidirectional !== undefined) {
      patch.bidirectional = bidirectional;
    }
    if (params.description !== undefined) {
      patch.description = { set: toLocalized(params.description, "description") };
    }
    const tags = optionalStringList(params.tags, "tags");
    if (tags !== undefined) {
      patch.tags = tags;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'scflow/update_flow: give at least one property to change besides "flow" (name, bidirectional, description, tags)',
      );
    }

    const { after } = await access.runCommand(locator, {
      kind: "update",
      schema: "flow",
      filters: { id: flow.id },
      input: patch,
    });
    return summarizeFlow(after[0] as unknown as Instance);
  },
};

/** Deletes a flow; see `scflow/delete_flow` in `docs/actions.md`. */
export const deleteFlowAction: ModelActionDefinition<DeleteFlowParams, { id: string }> = {
  id: "scflow/delete_flow",
  title: "Delete a flow",
  description: "Deletes a flow and returns its id. The items held by its ends are kept. A flow has no name: give its id.",
  parameters: {
    type: "object",
    properties: {
      flow: refParam("Id of the flow to delete."),
    },
    required: ["flow"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const flow = await resolveRef(access, locator, "flow", params.flow, "flow");
    await access.runCommand(locator, { kind: "delete", schema: "flow", filters: { id: flow.id } });
    return { id: flow.id };
  },
};

/** The actions of the lot flows and connectivity, in catalog order. */
export const FLOW_ACTIONS = [createFlowAction, updateFlowAction, setFlowItemAction, deleteFlowAction] as const;

function summarizeFlow(flow: Instance): FlowSummary {
  const summary: FlowSummary = {
    id: flow.id,
    source: flow.source as string,
    destination: flow.destination as string,
    bidirectional: flow.bidirectional as boolean,
  };
  if (flow.item) {
    summary.item = flow.item as string;
  }
  const name = flow.display_name as Record<string, string> | undefined | null;
  if (name && Object.keys(name).length > 0) {
    summary.display_name = name;
  }
  return summary;
}

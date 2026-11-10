import { type Instance } from "./refs.js";
import { cascadeParam, type ScflowActionDefinition, localizedTextParam, nullableLocalizedTextParam, refParam, tagsParam, unique } from "./params.js";
import { createFlow, setFlowItem } from "../flows.js";
import { localizedText } from "./text.js";

/** Parameters of `scflow/create_flow`. */
export interface CreateFlowParams {
  source: string;
  destination: string;
  item?: string;
  bidirectional?: boolean;
  display_name?: string | Record<string, string>;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/set_flow_item`. */
export interface SetFlowItemParams {
  id: string;
  item: string;
}

/** Parameters of `scflow/update_flow`. */
export interface UpdateFlowParams {
  id: string;
  display_name?: string | Record<string, string> | null;
  bidirectional?: boolean;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/delete_flow`. */
export interface DeleteFlowParams {
  id: string;
  cascade?: boolean;
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
export const createFlowAction: ScflowActionDefinition<CreateFlowParams, FlowSummary> = {
  id: "scflow/create_flow",
  writes: ["flow", "item_at_actor"],
  title: "Create a flow",
  description:
    "Creates a flow from a source actor to a destination actor and returns it. " +
    "Set bidirectional to true so that the flow carries items in both directions; it is one-way otherwise. " +
    "Give display_name to name the flow; it has no name otherwise. " +
    "A flow carries at most one item, given by item. A flow between an actor and one of its child actors, in either direction, " +
    "must carry an item, otherwise the action fails. The domain of the item must be among the domains of both actors, " +
    "and the actors that do not hold the item yet hold it afterwards.",
  parameters: {
    type: "object",
    properties: {
      source: refParam("actor", "Id or name of the actor the flow starts from."),
      destination: refParam("actor", "Id or name of the actor the flow arrives at."),
      item: refParam("item", "Id or name of the item the flow carries; required between an actor and its child."),
      bidirectional: {
        type: "boolean",
        description: "Whether the flow carries items in both directions; false when omitted.",
      },
      display_name: localizedTextParam(
        "Display name of the flow, a string or a map of language to string; the flow has no name when omitted.",
      ),
      description: localizedTextParam("Markdown description of the flow."),
      tags: tagsParam("Tags of the flow."),
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
  async run(params, context) {
    const bidirectional = params.bidirectional;
    const display_name = params.display_name === undefined ? undefined : await localizedText(context, params.display_name);
    const description = params.description === undefined ? undefined : await localizedText(context, params.description);
    const tags = unique(params.tags);

    const flow = await createFlow(context, context.locator, {
      source: params.source,
      destination: params.destination,
      ...(params.item === undefined ? {} : { item: params.item }),
      ...(bidirectional === undefined ? {} : { bidirectional }),
      ...(display_name === undefined ? {} : { display_name }),
      ...(description === undefined ? {} : { description }),
      ...(tags === undefined ? {} : { tags }),
    });
    return summarizeFlow(flow as unknown as Instance);
  },
};

/** Sets the item of a flow; see `scflow/set_flow_item` in `docs/actions.md`. */
export const setFlowItemAction: ScflowActionDefinition<SetFlowItemParams, FlowSummary> = {
  id: "scflow/set_flow_item",
  writes: ["flow", "item_at_actor"],
  title: "Set the item of a flow",
  description:
    "Sets the item carried by a flow that carries none, and returns the flow. The item of a flow never changes and is never removed: " +
    "the action fails when the flow carries another item, and changes nothing when it already carries this one. " +
    "The domain of the item must be among the domains of both the source and the destination, and the actors that do not hold " +
    "the item yet hold it afterwards.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow", "Id of the flow."),
      item: refParam("item", "Id or name of the item."),
    },
    required: ["id", "item"],
    additionalProperties: false,
  },
  async run(params, context) {
    return summarizeFlow((await setFlowItem(context, context.locator, { flow: params.id, item: params.item })) as unknown as Instance);
  },
};

/** Updates a flow; see `scflow/update_flow` in `docs/actions.md`. */
export const updateFlowAction: ScflowActionDefinition<UpdateFlowParams, FlowSummary> = {
  id: "scflow/update_flow",
  writes: ["flow"],
  title: "Update a flow",
  description:
    "Changes the name, the bidirectional flag, the description or the tags of a flow and returns it. Only the given properties change; " +
    "null removes the name. " +
    "The source and the destination of a flow never change: delete the flow and create it again.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow", "Id of the flow to update."),
      display_name: nullableLocalizedTextParam(
        "New display name; each given language replaces the same language, the others are kept. null removes the name.",
      ),
      bidirectional: {
        type: "boolean",
        description: "Whether the flow carries items in both directions.",
      },
      description: localizedTextParam("New Markdown description; each given language replaces the same language, the others are kept."),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const patch: Record<string, unknown> = {};

    if (params.display_name !== undefined) {
      patch.display_name = params.display_name === null ? null : { set: await localizedText(context, params.display_name) };
    }
    const bidirectional = params.bidirectional;
    if (bidirectional !== undefined) {
      patch.bidirectional = bidirectional;
    }
    if (params.description !== undefined) {
      patch.description = { set: await localizedText(context, params.description) };
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      patch.tags = tags;
    }

    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.flow",
      filters: { id: params.id },
      input: patch,
    });
    return summarizeFlow(after[0] as unknown as Instance);
  },
};

/** Deletes a flow; see `scflow/delete_flow` in `docs/actions.md`. */
export const deleteFlowAction: ScflowActionDefinition<DeleteFlowParams, { id: string }> = {
  id: "scflow/delete_flow",
  writes: ["flow"],
  destructive: true,
  title: "Delete a flow",
  description: "Deletes a flow and returns its id. The items held by its ends are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow", "Id of the flow to delete."),
      cascade: cascadeParam("Has no effect: nothing depends on a flow but its notes, which are always deleted with it."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await context.runCommand(context.locator, { kind: "delete", schema: "scflow.flow", filters: { id: params.id } });
    return { id: params.id };
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

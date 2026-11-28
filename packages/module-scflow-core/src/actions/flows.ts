import { type Instance } from "./refs.js";
import {
  cascadeParam,
  FLOW_DOMAINS,
  localizedTextParam,
  nullableRefParam,
  refParam,
  type ScflowActionDefinition,
  tagsParam,
  unique,
} from "./params.js";
import { deleteById } from "./delete-impact.js";
import { createFlow, setFlowItem } from "../flows.js";
import { localizedText } from "./text.js";
import { checkRouteServesFlows } from "./routes.js";

/** The directions of a flow type, in the declaration order of the `flow_direction` scalar type. */
const FLOW_DIRECTIONS = ["forward", "same-level", "reverse"] as const;

/** Parameters of `scflow/create_flow_type`. */
export interface CreateFlowTypeParams {
  name: string | Record<string, string>;
  domain: string;
  direction?: string;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/delete_flow_type`. */
export interface DeleteFlowTypeParams {
  id: string;
  cascade?: boolean;
}

/** A flow type as `scflow/create_flow_type` returns it. */
export interface FlowTypeSummary {
  id: string;
  name: Record<string, string>;
  domain: string;
  direction: string;
}

/** Parameters of `scflow/create_flow`. */
export interface CreateFlowParams {
  source: string;
  destination: string;
  type?: string;
  item?: string;
  bidirectional?: boolean;
  route?: string;
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
  type?: string | null;
  bidirectional?: boolean;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/delete_flow`. */
export interface DeleteFlowParams {
  id: string;
  cascade?: boolean;
}

/**
 * A flow as `scflow/create_flow` returns it; `type` is absent when it has none, `item` when it carries none and
 * `route` when it travels on none. A flow has no name: its source, destination, item and route identify it.
 */
export interface FlowSummary {
  id: string;
  source: string;
  destination: string;
  type?: string;
  item?: string;
  bidirectional: boolean;
  route?: string;
}

/** Creates a flow type; see `scflow/create_flow_type` in the topic `scflow/actions`. */
export const createFlowTypeAction: ScflowActionDefinition<CreateFlowTypeParams, FlowTypeSummary> = {
  id: "scflow/create_flow_type",
  writes: ["flow_type"],
  title: "Create a flow type",
  description:
    "Creates a flow type, what a flow means such as a delivery, a return or a disposal, bound to one flow domain " +
    "(physical, information, financial or service), with the direction of its flows, and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Name of the flow type, a string or a map of language to string."),
      domain: { type: "string", enum: [...FLOW_DOMAINS], description: "The flow domain of the flows of this type." },
      direction: {
        type: "string",
        enum: [...FLOW_DIRECTIONS],
        default: "forward",
        description:
          "Direction of the flows of this type: forward (default), along the main stream from suppliers to customers; " +
          "same-level, between peers such as an overflow warehouse or a subcontractor; reverse, against the main stream, as " +
          "reverse logistics (returns, recalls, disposal, empty packaging) and as a request, an order or a forecast going " +
          "upstream to ask for a delivery, while the delivery itself stays forward. Independent of the bidirectional flag of a flow.",
      },
      description: localizedTextParam("Markdown description of the flow type."),
      tags: tagsParam("Tags of the flow type."),
    },
    required: ["name", "domain"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { name: await localizedText(context, params.name), domain: params.domain };
    if (params.direction !== undefined) input.direction = params.direction;
    if (params.description !== undefined) input.description = await localizedText(context, params.description);
    const tags = unique(params.tags);
    if (tags !== undefined) input.tags = tags;
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.flow_type", input });
    const flowType = after[0] as unknown as Instance;
    return {
      id: flowType.id,
      name: flowType.name as Record<string, string>,
      domain: flowType.domain as string,
      direction: flowType.direction as string,
    };
  },
};

/** Deletes a flow type; see `scflow/delete_flow_type` in the topic `scflow/actions`. */
export const deleteFlowTypeAction: ScflowActionDefinition<DeleteFlowTypeParams, { id: string }> = {
  id: "scflow/delete_flow_type",
  writes: ["flow_type", "flow"],
  destructive: true,
  title: "Delete a flow type",
  description:
    "Deletes a flow type and returns its id. The flows that have this type are kept and have no type afterwards. " +
    "The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow_type", "Id or name of the flow type to delete."),
      cascade: cascadeParam("Has no effect: deleting a flow type never deletes a flow."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    // The relation `type` of a flow has no `on_delete`, so the engine clears it on the flows of the type.
    await deleteById(context, "scflow.flow_type", params.id);
    return { id: params.id };
  },
};

/** Creates a flow between two actors; see `scflow/create_flow` in the topic `scflow/actions`. */
export const createFlowAction: ScflowActionDefinition<CreateFlowParams, FlowSummary> = {
  id: "scflow/create_flow",
  writes: ["flow", "item_at_actor"],
  title: "Create a flow",
  description:
    "Creates a flow from a source actor to a destination actor and returns it. " +
    "Set bidirectional to true so that the flow carries items in both directions; it is one-way otherwise. " +
    "A flow has no name: its source, destination, item and route identify it, and the description holds what else there is to say. " +
    "A flow carries at most one item, given by item. A flow between an actor and one of its child actors, in either direction, " +
    "must carry an item, otherwise the action fails. The domain of the item must be among the domains of both actors, " +
    "and the actors that do not hold the item yet hold it afterwards. " +
    "Give type to say what the flow means: its domain must be among the domains of both actors and is the domain of the item; " +
    "a flow without an item takes its domain from its type. " +
    "Give route to make the flow travel on an existing route, as scflow/set_flow_route does; creating a flow never creates a route.",
  parameters: {
    type: "object",
    properties: {
      source: refParam("actor", "Id or name of the actor the flow starts from."),
      destination: refParam("actor", "Id or name of the actor the flow arrives at."),
      type: refParam("flow_type", "Id or name of the flow type; none when omitted."),
      item: refParam("item", "Id or name of the item the flow carries; required between an actor and its child."),
      bidirectional: {
        type: "boolean",
        description: "Whether the flow carries items in both directions; false when omitted.",
      },
      route: refParam("route", "Id or name of the route the flow travels on; none when omitted."),
      description: localizedTextParam("Markdown description of the flow."),
      tags: tagsParam("Tags of the flow."),
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
  async run(params, context) {
    const bidirectional = params.bidirectional;
    const description = params.description === undefined ? undefined : await localizedText(context, params.description);
    const tags = unique(params.tags);

    const flow = await createFlow(context, context.locator, {
      source: params.source,
      destination: params.destination,
      ...(params.type === undefined ? {} : { type: params.type }),
      ...(params.item === undefined ? {} : { item: params.item }),
      ...(bidirectional === undefined ? {} : { bidirectional }),
      ...(params.route === undefined ? {} : { route: params.route }),
      ...(description === undefined ? {} : { description }),
      ...(tags === undefined ? {} : { tags }),
    });
    if (params.route !== undefined) await checkRouteServesFlows(context, params.route, [flow.id as string]);
    return summarizeFlow(flow as unknown as Instance);
  },
};

/** Sets the item of a flow; see `scflow/set_flow_item` in the topic `scflow/actions`. */
export const setFlowItemAction: ScflowActionDefinition<SetFlowItemParams, FlowSummary> = {
  id: "scflow/set_flow_item",
  writes: ["flow", "item_at_actor"],
  title: "Set the item of a flow",
  description:
    "Sets the item carried by a flow that carries none, and returns the flow. The item of a flow never changes and is never removed: " +
    "the action fails when the flow carries another item, and changes nothing when it already carries this one. " +
    "The domain of the item must be among the domains of both the source and the destination, and is the domain of the flow type " +
    "when the flow has one. The actors that do not hold the item yet hold it afterwards.",
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

/** Updates a flow; see `scflow/update_flow` in the topic `scflow/actions`. */
export const updateFlowAction: ScflowActionDefinition<UpdateFlowParams, FlowSummary> = {
  id: "scflow/update_flow",
  writes: ["flow"],
  title: "Update a flow",
  description:
    "Changes the type, bidirectional flag, description or tags of a flow and returns it. Only the given properties change; " +
    "type accepts null to remove it. A type whose domain differs from the item or the route of the flow, or is not among the " +
    "domains of both its ends, is refused. " +
    "The source and the destination of a flow never change: delete the flow and create it again. " +
    "Making a flow bidirectional is refused when its route does not serve the other direction. Its route changes with scflow/set_flow_route.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow", "Id of the flow to update."),
      type: nullableRefParam("flow_type", "Id or name of the new flow type, or null to remove the type of the flow."),
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

    if (params.type !== undefined) {
      patch.type = params.type;
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
    const flow = after[0] as unknown as Instance;
    if (bidirectional === true && flow.route) await checkRouteServesFlows(context, flow.route as string, [flow.id]);
    return summarizeFlow(flow);
  },
};

/** Deletes a flow; see `scflow/delete_flow` in the topic `scflow/actions`. */
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
export const FLOW_ACTIONS = [createFlowTypeAction, deleteFlowTypeAction, createFlowAction, updateFlowAction, setFlowItemAction, deleteFlowAction] as const;

/** The summary of a flow that the flow actions return. */
export function summarizeFlow(flow: Instance): FlowSummary {
  const summary: FlowSummary = {
    id: flow.id,
    source: flow.source as string,
    destination: flow.destination as string,
    bidirectional: flow.bidirectional as boolean,
  };
  if (flow.type) {
    summary.type = flow.type as string;
  }
  if (flow.item) {
    summary.item = flow.item as string;
  }
  if (flow.route) {
    summary.route = flow.route as string;
  }
  return summary;
}

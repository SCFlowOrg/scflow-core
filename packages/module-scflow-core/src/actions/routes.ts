import { labelOf, loadInstance, type Instance } from "./refs.js";
import {
  type ActionAccess,
  cascadeParam,
  FLOW_DOMAINS,
  localizedTextParam,
  nullableLocalizedTextParam,
  nullableRefParam,
  type ParamProperty,
  refParam,
  type ScflowActionDefinition,
  tagsParam,
  textParam,
  unique,
} from "./params.js";
import { localizedText } from "./text.js";
import { DURATION_PATTERN, leadTimeOnRoute } from "../routes.js";
import { deleteById } from "./delete-impact.js";
import { type FlowSummary, summarizeFlow } from "./flows.js";

/** Parameters of `scflow/create_mode`. */
export interface CreateModeParams {
  name: string | Record<string, string>;
  domain: string;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/delete_mode`. */
export interface DeleteModeParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/create_route`. */
export interface CreateRouteParams {
  name: string;
  mode: string;
  description?: string | Record<string, string>;
  schedule?: string | Record<string, string>;
  bidirectional?: boolean;
  tags?: string[];
}

/** Parameters of `scflow/update_route`. */
export interface UpdateRouteParams {
  id: string;
  name?: string;
  description?: string | Record<string, string> | null;
  mode?: string;
  schedule?: string | Record<string, string> | null;
  bidirectional?: boolean;
  tags?: string[];
}

/** Parameters of `scflow/delete_route`. */
export interface DeleteRouteParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/add_route_stop`. */
export interface AddRouteStopParams {
  route: string;
  actor: string;
  sequence?: number;
  lead_time?: string;
  reverse_lead_time?: string;
  tags?: string[];
}

/** Parameters of `scflow/update_route_stop`. */
export interface UpdateRouteStopParams {
  id: string;
  sequence?: number;
  lead_time?: string | null;
  reverse_lead_time?: string | null;
  tags?: string[];
}

/** Parameters of `scflow/remove_route_stop`. */
export interface RemoveRouteStopParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/set_flow_route`. */
export interface SetFlowRouteParams {
  id: string;
  route: string | null;
}

/** Parameters of `scflow/create_route_from_flows`. */
export interface CreateRouteFromFlowsParams {
  flows: string[];
  mode: string;
  name: string;
  description?: string | Record<string, string>;
  schedule?: string | Record<string, string>;
  bidirectional?: boolean;
  lead_time?: string;
  reverse_lead_time?: string;
  tags?: string[];
}

/** Parameters of `scflow/inspect_route`. */
export interface InspectRouteParams {
  id: string;
}

/** A mode as `scflow/create_mode` returns it. */
export interface ModeSummary {
  id: string;
  name: Record<string, string>;
  domain: string;
}

/** A stop of a route; `lead_time` and `reverse_lead_time` are absent when not given. */
export interface RouteStopSummary {
  id: string;
  route: string;
  actor: string;
  sequence: number;
  lead_time?: string;
  reverse_lead_time?: string;
}

/** A route with its stops in order and the ids of its flows. */
export interface RouteSummary {
  id: string;
  name: string;
  mode: string;
  bidirectional: boolean;
  schedule?: Record<string, string>;
  stops: RouteStopSummary[];
  flows: string[];
}

/** A flow of a route with its derived lead times, as `scflow/inspect_route` returns it. */
export interface RouteFlowLeadTime {
  id: string;
  source: string;
  destination: string;
  bidirectional: boolean;
  item?: string;
  /** The lead time from the source to the destination; `null` when a leg of the path has none. */
  lead_time: string | null;
  /** For a bidirectional flow, the lead time from the destination back to the source. */
  reverse_lead_time?: string | null;
}

/** The result of `scflow/inspect_route`. */
export interface InspectRouteResult extends RouteSummary {
  /** The flow domain of the route, the domain of its mode. */
  domain: string;
  /** The flows of the route with their lead times. */
  lead_times: RouteFlowLeadTime[];
  /**
   * The ids of the stops whose actor is the end of no flow of the route, such as a transit hub or a
   * truck depot where a round trip starts and ends.
   */
  stops_without_flow: string[];
}

/** JSON Schema of an ISO 8601 duration parameter. */
function durationParam(description: string): ParamProperty {
  return { type: "string", pattern: DURATION_PATTERN, description };
}

/** JSON Schema of an ISO 8601 duration parameter that also accepts `null`, to clear the value. */
function nullableDurationParam(description: string): ParamProperty {
  return { type: ["string", "null"], pattern: DURATION_PATTERN, description } as unknown as ParamProperty;
}

/** Creates a mode; see `scflow/create_mode` in the topic `scflow/actions`. */
export const createModeAction: ScflowActionDefinition<CreateModeParams, ModeSummary> = {
  id: "scflow/create_mode",
  writes: ["mode"],
  title: "Create a mode",
  description:
    "Creates a mode, the category of transport or exchange such as road, sea, air, rail, EDI or payment, bound to one flow domain " +
    "(physical, information, financial or service), and returns it. A mode is the category; a route is the instance.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Name of the mode, a string or a map of language to string."),
      domain: { type: "string", enum: [...FLOW_DOMAINS], description: "The flow domain of the routes of this mode." },
      description: localizedTextParam("Markdown description of the mode."),
      tags: tagsParam("Tags of the mode."),
    },
    required: ["name", "domain"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { name: await localizedText(context, params.name), domain: params.domain };
    if (params.description !== undefined) input.description = await localizedText(context, params.description);
    const tags = unique(params.tags);
    if (tags !== undefined) input.tags = tags;
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.mode", input });
    const mode = after[0] as unknown as Instance;
    return { id: mode.id, name: mode.name as Record<string, string>, domain: mode.domain as string };
  },
};

/** Deletes a mode; see `scflow/delete_mode` in the topic `scflow/actions`. */
export const deleteModeAction: ScflowActionDefinition<DeleteModeParams, { id: string }> = {
  id: "scflow/delete_mode",
  writes: ["mode", "route", "route_stop", "flow"],
  destructive: true,
  title: "Delete a mode",
  description:
    "Deletes a mode. It is refused while routes have this mode, unless cascade is true, which deletes those routes first, " +
    "each with the cascade of scflow/delete_route: their stops are deleted and their flows are kept, on no route.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode", "Id or name of the mode to delete."),
      cascade: cascadeParam("When true, also deletes the routes of this mode with their stops and notes; their flows are kept."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.mode", params.id, params.cascade);
    return { id: params.id };
  },
};

/** Creates a route; see `scflow/create_route` in the topic `scflow/actions`. */
export const createRouteAction: ScflowActionDefinition<CreateRouteParams, RouteSummary> = {
  id: "scflow/create_route",
  writes: ["route"],
  title: "Create a route",
  description:
    "Creates a route, the instance that says how flows travel (a shuttle, a weekly round trip, an EDI link), of a given mode, " +
    "with no stop and no flow yet, and returns it. Add its stops with scflow/add_route_stop and assign flows with scflow/set_flow_route. " +
    "Set bidirectional to true when the stops are served in both orders; it is false otherwise. The schedule is a free text.",
  parameters: {
    type: "object",
    properties: {
      name: textParam("Name of the route, unique among the routes."),
      mode: refParam("mode", "Id or name of the mode."),
      description: localizedTextParam("Markdown description of the route."),
      schedule: localizedTextParam("Schedule of the route as a free text, such as every Monday."),
      bidirectional: { type: "boolean", description: "Whether the stops are served in both orders; false when omitted." },
      tags: tagsParam("Tags of the route."),
    },
    required: ["name", "mode"],
    additionalProperties: false,
  },
  async run(params, context) {
    const route = await createRoute(context, params);
    return summarizeRoute(context, route);
  },
};

/** Updates a route; see `scflow/update_route` in the topic `scflow/actions`. */
export const updateRouteAction: ScflowActionDefinition<UpdateRouteParams, RouteSummary> = {
  id: "scflow/update_route",
  writes: ["route"],
  title: "Update a route",
  description:
    "Changes the name, description, mode, schedule, bidirectional flag or tags of a route and returns it. Only the given properties " +
    "change; null clears the description or the schedule. A change of mode whose domain differs from the items of the flows of the " +
    "route is refused, and so is making a route one-way while a flow needs it in the other direction.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("route", "Id or name of the route to update."),
      name: textParam("New name of the route."),
      description: nullableLocalizedTextParam("New Markdown description; each given language replaces the same language, the others are kept. null removes the description."),
      mode: refParam("mode", "Id or name of the new mode."),
      schedule: nullableLocalizedTextParam("New schedule; each given language replaces the same language, the others are kept. null removes the schedule."),
      bidirectional: { type: "boolean", description: "Whether the stops are served in both orders." },
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const patch: Record<string, unknown> = {};
    if (params.name !== undefined) patch.name = params.name;
    if (params.description !== undefined) {
      patch.description = params.description === null ? null : { set: await localizedText(context, params.description) };
    }
    if (params.mode !== undefined) patch.mode = params.mode;
    if (params.schedule !== undefined) {
      patch.schedule = params.schedule === null ? null : { set: await localizedText(context, params.schedule) };
    }
    if (params.bidirectional !== undefined) patch.bidirectional = params.bidirectional;
    const tags = unique(params.tags);
    if (tags !== undefined) patch.tags = tags;

    const { after } = await context.runCommand(context.locator, { kind: "update", schema: "scflow.route", filters: { id: params.id }, input: patch });
    if (params.bidirectional === false) await checkRouteServesFlows(context, params.id);
    return summarizeRoute(context, after[0] as unknown as Instance);
  },
};

/** Deletes a route; see `scflow/delete_route` in the topic `scflow/actions`. */
export const deleteRouteAction: ScflowActionDefinition<DeleteRouteParams, { id: string }> = {
  id: "scflow/delete_route",
  writes: ["route", "route_stop", "flow"],
  destructive: true,
  title: "Delete a route",
  description:
    "Deletes a route with its stops and notes, and returns its id. It is refused while flows travel on the route, unless cascade is " +
    "true, which keeps those flows and clears their route.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("route", "Id or name of the route to delete."),
      cascade: cascadeParam("When true, also clears the route of the flows that travel on it; the flows are kept."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    const flows = await query(context, "scflow.flow", { route: params.id });
    if (flows.length > 0 && params.cascade !== true) {
      const route = await loadInstance(context, "scflow.route", params.id);
      throw new Error(`route "${labelOf(route)}" carries ${flows.length} flow(s): delete it with cascade true to clear their route`);
    }
    await deleteById(context, "scflow.route", params.id);
    return { id: params.id };
  },
};

/** Adds a stop to a route; see `scflow/add_route_stop` in the topic `scflow/actions`. */
export const addRouteStopAction: ScflowActionDefinition<AddRouteStopParams, RouteStopSummary> = {
  id: "scflow/add_route_stop",
  writes: ["route_stop"],
  title: "Add a stop to a route",
  description:
    "Adds a stop at an actor to a route, at the position given by sequence (1 for the first stop), or after the last stop when " +
    "sequence is omitted, and returns it. The stops from that position on move one place down. An actor may have several stops on " +
    "one route, such as the start and the end of a round trip. lead_time is the ISO 8601 duration of the leg from the previous stop, " +
    "such as P2D or PT4H30M, and is ignored on the first stop; reverse_lead_time is the duration of the same leg backwards on a " +
    "bidirectional route, equal to lead_time when omitted.",
  parameters: {
    type: "object",
    properties: {
      route: refParam("route", "Id or name of the route."),
      actor: refParam("actor", "Id or name of the actor of the stop."),
      sequence: { type: "integer", minimum: 1, description: "Position of the stop, from 1; after the last stop when omitted." },
      lead_time: durationParam("ISO 8601 duration of the leg from the previous stop to this one."),
      reverse_lead_time: durationParam("ISO 8601 duration of the leg from this stop back to the previous one; lead_time when omitted."),
      tags: tagsParam("Tags of the stop."),
    },
    required: ["route", "actor"],
    additionalProperties: false,
  },
  async run(params, context) {
    const stop = await addRouteStop(context, params);
    return summarizeStop(stop);
  },
};

/** Moves a stop or changes its lead times; see `scflow/update_route_stop` in the topic `scflow/actions`. */
export const updateRouteStopAction: ScflowActionDefinition<UpdateRouteStopParams, RouteStopSummary> = {
  id: "scflow/update_route_stop",
  writes: ["route_stop"],
  title: "Update a stop of a route",
  description:
    "Moves a stop of a route to another position, given by sequence, or changes its lead times or tags, and returns it. The other " +
    "stops keep their order. null clears a lead time. A move after which the route no longer serves one of its flows, a stop of the " +
    "source before a stop of the destination, is refused.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("route_stop", "Id of the stop."),
      sequence: { type: "integer", minimum: 1, description: "New position of the stop, from 1, at most the number of stops." },
      lead_time: nullableDurationParam("New ISO 8601 duration of the leg from the previous stop; null clears it."),
      reverse_lead_time: nullableDurationParam("New ISO 8601 duration of the leg backwards; null clears it."),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const stop = await loadInstance(context, "scflow.route_stop", params.id);
    const routeId = stop.route as string;
    const patch: Record<string, unknown> = {};
    if (params.lead_time !== undefined) patch.lead_time = params.lead_time;
    if (params.reverse_lead_time !== undefined) patch.reverse_lead_time = params.reverse_lead_time;
    const tags = unique(params.tags);
    if (tags !== undefined) patch.tags = tags;
    if (Object.keys(patch).length > 0) {
      await context.runCommand(context.locator, { kind: "update", schema: "scflow.route_stop", filters: { id: stop.id }, input: patch });
    }
    if (params.sequence !== undefined && params.sequence !== stop.sequence) {
      const others = (await stopsOf(context, routeId)).filter((other) => other.id !== stop.id);
      if (params.sequence > others.length + 1) {
        throw new Error(`sequence ${params.sequence} is beyond the ${others.length + 1} stops of the route`);
      }
      others.splice(params.sequence - 1, 0, stop);
      await renumber(context, others);
      await checkRouteServesFlows(context, routeId);
    }
    return summarizeStop(await loadInstance(context, "scflow.route_stop", stop.id));
  },
};

/** Removes a stop from a route; see `scflow/remove_route_stop` in the topic `scflow/actions`. */
export const removeRouteStopAction: ScflowActionDefinition<RemoveRouteStopParams, { id: string }> = {
  id: "scflow/remove_route_stop",
  writes: ["route_stop"],
  destructive: true,
  title: "Remove a stop from a route",
  description:
    "Removes a stop from its route and returns its id; the following stops move one place up. It is refused when a flow of the route " +
    "needs the stop: its source or destination would no longer be a stop, or no stop of its source would come before a stop of its " +
    "destination. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("route_stop", "Id of the stop to remove."),
      cascade: cascadeParam("Has no effect: nothing depends on a stop but its notes, which are always deleted with it."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    const stop = await loadInstance(context, "scflow.route_stop", params.id);
    const routeId = stop.route as string;
    await deleteById(context, "scflow.route_stop", stop.id);
    await renumber(context, await stopsOf(context, routeId));
    await checkRouteServesFlows(context, routeId);
    return { id: params.id };
  },
};

/** Assigns or clears the route of a flow; see `scflow/set_flow_route` in the topic `scflow/actions`. */
export const setFlowRouteAction: ScflowActionDefinition<SetFlowRouteParams, FlowSummary> = {
  id: "scflow/set_flow_route",
  writes: ["flow"],
  title: "Set the route of a flow",
  description:
    "Makes a flow travel on a route, or on none with null, and returns the flow. A flow travels on at most one route, so this replaces " +
    "its route. The source and the destination of the flow must be stops of the route, a stop of the source before a stop of the " +
    "destination unless the route is bidirectional; a bidirectional flow also needs the other direction. The item of the flow must " +
    "be in the domain of the mode.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow", "Id of the flow."),
      route: nullableRefParam("route", "Id or name of the route, or null to take the flow off its route."),
    },
    required: ["id", "route"],
    additionalProperties: false,
  },
  async run(params, context) {
    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.flow",
      filters: { id: params.id },
      input: { route: params.route },
    });
    if (params.route !== null) await checkRouteServesFlows(context, params.route, [params.id]);
    return summarizeFlow(after[0] as unknown as Instance);
  },
};

/** Creates a route from flows; see `scflow/create_route_from_flows` in the topic `scflow/actions`. */
export const createRouteFromFlowsAction: ScflowActionDefinition<CreateRouteFromFlowsParams, RouteSummary> = {
  id: "scflow/create_route_from_flows",
  writes: ["route", "route_stop", "flow"],
  title: "Create a route from flows",
  description:
    "Creates a route of a given mode for flows that share their source and their destination and travel on no route yet, with two " +
    "stops, the source then the destination, makes the flows travel on it and returns it. The items of the flows must be in the " +
    "domain of the mode. lead_time is the ISO 8601 duration from the source to the destination. The route is bidirectional " +
    "when bidirectional is true, or when it is omitted and one of the flows is bidirectional.",
  parameters: {
    type: "object",
    properties: {
      flows: { type: "array", minItems: 1, items: { type: "string", ref: "flow" }, description: "Ids of the flows, at least one." } as unknown as ParamProperty,
      mode: refParam("mode", "Id or name of the mode."),
      name: textParam("Name of the route, unique among the routes."),
      description: localizedTextParam("Markdown description of the route."),
      schedule: localizedTextParam("Schedule of the route as a free text, such as every Monday."),
      bidirectional: { type: "boolean", description: "Whether the route serves its stops in both orders; true when omitted and a flow is bidirectional." },
      lead_time: durationParam("ISO 8601 duration from the source to the destination."),
      reverse_lead_time: durationParam("ISO 8601 duration from the destination back to the source; lead_time when omitted."),
      tags: tagsParam("Tags of the route."),
    },
    required: ["flows", "mode", "name"],
    additionalProperties: false,
  },
  async run(params, context) {
    const flowIds = [...new Set(params.flows)];
    const flows = await Promise.all(flowIds.map((id) => loadInstance(context, "scflow.flow", id)));
    const [first] = flows;
    for (const flow of flows) {
      if (flow.source !== first.source || flow.destination !== first.destination) {
        throw new Error(`flow "${flow.id}" does not share the source and the destination of flow "${first.id}"`);
      }
      if (flow.route) {
        throw new Error(`flow "${flow.id}" already travels on a route: take it off with scflow/set_flow_route first`);
      }
    }
    const bidirectional = params.bidirectional ?? flows.some((flow) => flow.bidirectional === true);
    const route = await createRoute(context, { ...params, bidirectional });
    await addRouteStop(context, { route: route.id, actor: first.source as string });
    await addRouteStop(context, {
      route: route.id,
      actor: first.destination as string,
      ...(params.lead_time === undefined ? {} : { lead_time: params.lead_time }),
      ...(params.reverse_lead_time === undefined ? {} : { reverse_lead_time: params.reverse_lead_time }),
    });
    for (const id of flowIds) {
      await context.runCommand(context.locator, { kind: "update", schema: "scflow.flow", filters: { id }, input: { route: route.id } });
    }
    await checkRouteServesFlows(context, route.id);
    return summarizeRoute(context, route);
  },
};

/** Describes a route with the lead times of its flows; see `scflow/inspect_route` in the topic `scflow/actions`. */
export const inspectRouteAction: ScflowActionDefinition<InspectRouteParams, InspectRouteResult> = {
  id: "scflow/inspect_route",
  writes: [],
  kind: "read",
  title: "Inspect a route",
  description:
    "Describes a route: its mode and domain, its stops in order with their lead times, and each of its flows with its lead time, the " +
    "sum of the lead times of the legs from a stop of its source to a stop of its destination; a bidirectional flow also has the " +
    "lead time back. A lead time is null when a leg of the path has none. stops_without_flow lists the stops that are the end of " +
    "no flow of the route, such as a transit hub or a truck depot where a round trip starts and ends. It changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("route", "Id or name of the route."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    const route = await loadInstance(context, "scflow.route", params.id);
    const mode = await loadInstance(context, "scflow.mode", route.mode);
    const summary = await summarizeRoute(context, route);
    const stops = await stopsOf(context, route.id);
    const flows = await query(context, "scflow.flow", { route: route.id });
    const bidirectional = route.bidirectional === true;
    const leadTime = (from: string, to: string) => leadTimeOnRoute(stopInputs(stops), from, to, bidirectional)?.lead_time ?? null;

    const lead_times = flows.map((flow): RouteFlowLeadTime => {
      const source = flow.source as string;
      const destination = flow.destination as string;
      return {
        id: flow.id,
        source,
        destination,
        bidirectional: flow.bidirectional === true,
        ...(flow.item ? { item: flow.item as string } : {}),
        lead_time: leadTime(source, destination),
        ...(flow.bidirectional === true ? { reverse_lead_time: leadTime(destination, source) } : {}),
      };
    });
    const ends = new Set(flows.flatMap((flow) => [flow.source as string, flow.destination as string]));
    const stops_without_flow = stops.filter((stop) => !ends.has(stop.actor as string)).map((stop) => stop.id);
    return { ...summary, domain: mode.domain as string, lead_times, stops_without_flow };
  },
};

/** The actions of the lot routes, in catalog order. */
export const ROUTE_ACTIONS = [
  createModeAction,
  deleteModeAction,
  createRouteAction,
  updateRouteAction,
  deleteRouteAction,
  addRouteStopAction,
  updateRouteStopAction,
  removeRouteStopAction,
  setFlowRouteAction,
  createRouteFromFlowsAction,
  inspectRouteAction,
] as const;

/**
 * Refuses the flows of a route that it does not serve (rule `route_serves_flow`): a flow needs a stop
 * of its source before a stop of its destination, or the route bidirectional, and a bidirectional
 * flow needs the other direction too. A flow whose source or destination is not a stop is left to
 * the declared rule `route_stops_hold_flow_ends`.
 *
 * @param flowIds The flows to check; every flow of the route when absent.
 * @throws When the route does not serve a flow, naming the rule, the route and the flow.
 */
export async function checkRouteServesFlows(context: ActionAccess, routeId: string, flowIds?: readonly string[]): Promise<void> {
  const route = await loadInstance(context, "scflow.route", routeId);
  const stops = stopInputs(await stopsOf(context, routeId));
  const actors = new Set(stops.map((stop) => stop.actor));
  const bidirectional = route.bidirectional === true;
  const flows = (await query(context, "scflow.flow", { route: routeId })).filter((flow) => !flowIds || flowIds.includes(flow.id));
  for (const flow of flows) {
    const source = flow.source as string;
    const destination = flow.destination as string;
    if (!actors.has(source) || !actors.has(destination)) continue;
    const served =
      leadTimeOnRoute(stops, source, destination, bidirectional) !== undefined &&
      (flow.bidirectional !== true || leadTimeOnRoute(stops, destination, source, bidirectional) !== undefined);
    if (!served) {
      const direction = flow.bidirectional === true ? "in both directions" : "from its source to its destination";
      throw new Error(`rule route_serves_flow: route "${labelOf(route)}" does not serve flow "${flow.id}" ${direction}`);
    }
  }
}

/** The stops of a route, in the order of their sequence. */
export async function stopsOf(context: ActionAccess, routeId: string): Promise<Instance[]> {
  const stops = await query(context, "scflow.route_stop", { route: routeId });
  return stops.sort((a, b) => (a.sequence as number) - (b.sequence as number));
}

async function createRoute(context: ActionAccess, params: CreateRouteParams): Promise<Instance> {
  const input: Record<string, unknown> = {
    name: params.name,
    mode: params.mode,
    bidirectional: params.bidirectional ?? false,
  };
  if (params.description !== undefined) input.description = await localizedText(context, params.description);
  if (params.schedule !== undefined) input.schedule = await localizedText(context, params.schedule);
  const tags = unique(params.tags);
  if (tags !== undefined) input.tags = tags;
  const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.route", input });
  return after[0] as unknown as Instance;
}

async function addRouteStop(context: ActionAccess, params: AddRouteStopParams): Promise<Instance> {
  // Deleting an actor deletes its stops and may leave a gap in the sequences: closed first.
  const stops = await stopsOf(context, params.route);
  await renumber(context, stops);
  stops.forEach((stop, index) => (stop.sequence = index + 1));
  const sequence = params.sequence ?? stops.length + 1;
  if (sequence > stops.length + 1) {
    throw new Error(`sequence ${sequence} is beyond the end of the route, which has ${stops.length} stop(s)`);
  }
  // Shifted from the last, so that two stops never share a sequence on the way.
  for (const stop of stops.slice(sequence - 1).reverse()) {
    await setSequence(context, stop.id, (stop.sequence as number) + 1);
  }
  // An absent duration is written null: the default of a string, "", is not a duration.
  const input: Record<string, unknown> = {
    route: params.route,
    actor: params.actor,
    sequence,
    lead_time: params.lead_time ?? null,
    reverse_lead_time: params.reverse_lead_time ?? null,
  };
  const tags = unique(params.tags);
  if (tags !== undefined) input.tags = tags;
  const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.route_stop", input });
  return after[0] as unknown as Instance;
}

/** Gives the stops their position in the list as sequence, from 1. */
async function renumber(context: ActionAccess, stops: readonly Instance[]): Promise<void> {
  for (const [index, stop] of stops.entries()) {
    if (stop.sequence !== index + 1) await setSequence(context, stop.id, index + 1);
  }
}

async function setSequence(context: ActionAccess, id: string, sequence: number): Promise<void> {
  await context.runCommand(context.locator, { kind: "update", schema: "scflow.route_stop", filters: { id }, input: { sequence } });
}

async function query(context: ActionAccess, schema: string, filters?: Record<string, unknown>): Promise<Instance[]> {
  const { after } = await context.runCommand(context.locator, { kind: "query", schema, ...(filters ? { filters } : {}) } as never);
  return after as unknown as Instance[];
}

function stopInputs(stops: readonly Instance[]) {
  return stops.map((stop) => ({
    actor: stop.actor as string,
    lead_time: (stop.lead_time as string | undefined) || null,
    reverse_lead_time: (stop.reverse_lead_time as string | undefined) || null,
  }));
}

async function summarizeRoute(context: ActionAccess, route: Instance): Promise<RouteSummary> {
  const current = await loadInstance(context, "scflow.route", route.id);
  const schedule = current.schedule as Record<string, string> | undefined | null;
  const flows = await query(context, "scflow.flow", { route: route.id });
  return {
    id: current.id,
    name: current.name as string,
    mode: current.mode as string,
    bidirectional: current.bidirectional === true,
    ...(schedule && Object.keys(schedule).length > 0 ? { schedule } : {}),
    stops: (await stopsOf(context, route.id)).map(summarizeStop),
    flows: flows.map((flow) => flow.id),
  };
}

function summarizeStop(stop: Instance): RouteStopSummary {
  return {
    id: stop.id,
    route: stop.route as string,
    actor: stop.actor as string,
    sequence: stop.sequence as number,
    ...(stop.lead_time ? { lead_time: stop.lead_time as string } : {}),
    ...(stop.reverse_lead_time ? { reverse_lead_time: stop.reverse_lead_time as string } : {}),
  };
}

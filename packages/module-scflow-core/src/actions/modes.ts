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
  unique,
} from "./params.js";
import { localizedText } from "./text.js";
import { DURATION_PATTERN, leadTimeOnMode } from "../modes.js";
import { deleteById } from "./delete-impact.js";
import { type FlowSummary, summarizeFlow } from "./flows.js";

/** Parameters of `scflow/create_mode_type`. */
export interface CreateModeTypeParams {
  display_name: string | Record<string, string>;
  domain: string;
  description?: string | Record<string, string>;
  tags?: string[];
}

/** Parameters of `scflow/delete_mode_type`. */
export interface DeleteModeTypeParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/create_mode`. */
export interface CreateModeParams {
  display_name: string | Record<string, string>;
  type: string;
  description?: string | Record<string, string>;
  schedule?: string | Record<string, string>;
  bidirectional?: boolean;
  tags?: string[];
}

/** Parameters of `scflow/update_mode`. */
export interface UpdateModeParams {
  id: string;
  display_name?: string | Record<string, string>;
  description?: string | Record<string, string> | null;
  type?: string;
  schedule?: string | Record<string, string> | null;
  bidirectional?: boolean;
  tags?: string[];
}

/** Parameters of `scflow/delete_mode`. */
export interface DeleteModeParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/add_mode_stop`. */
export interface AddModeStopParams {
  mode: string;
  actor: string;
  sequence?: number;
  lead_time?: string;
  reverse_lead_time?: string;
  tags?: string[];
}

/** Parameters of `scflow/update_mode_stop`. */
export interface UpdateModeStopParams {
  id: string;
  sequence?: number;
  lead_time?: string | null;
  reverse_lead_time?: string | null;
  tags?: string[];
}

/** Parameters of `scflow/remove_mode_stop`. */
export interface RemoveModeStopParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/set_flow_mode`. */
export interface SetFlowModeParams {
  id: string;
  mode: string | null;
}

/** Parameters of `scflow/create_mode_from_flows`. */
export interface CreateModeFromFlowsParams {
  flows: string[];
  type: string;
  display_name: string | Record<string, string>;
  description?: string | Record<string, string>;
  schedule?: string | Record<string, string>;
  bidirectional?: boolean;
  lead_time?: string;
  reverse_lead_time?: string;
  tags?: string[];
}

/** Parameters of `scflow/inspect_mode`. */
export interface InspectModeParams {
  id: string;
}

/** A mode type as `scflow/create_mode_type` returns it. */
export interface ModeTypeSummary {
  id: string;
  display_name: Record<string, string>;
  domain: string;
}

/** A stop of a mode; `lead_time` and `reverse_lead_time` are absent when not given. */
export interface ModeStopSummary {
  id: string;
  mode: string;
  actor: string;
  sequence: number;
  lead_time?: string;
  reverse_lead_time?: string;
}

/** A mode with its stops in order and the ids of its flows. */
export interface ModeSummary {
  id: string;
  display_name: Record<string, string>;
  type: string;
  bidirectional: boolean;
  schedule?: Record<string, string>;
  stops: ModeStopSummary[];
  flows: string[];
}

/** A flow of a mode with its derived lead times, as `scflow/inspect_mode` returns it. */
export interface ModeFlowLeadTime {
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

/** The result of `scflow/inspect_mode`. */
export interface InspectModeResult extends ModeSummary {
  /** The flow domain of the mode, the domain of its type. */
  domain: string;
  /** The flows of the mode with their lead times. */
  lead_times: ModeFlowLeadTime[];
  /** The ids of the stops whose actor is the end of no flow of the mode, such as a transit hub. */
  idle_stops: string[];
}

/** JSON Schema of an ISO 8601 duration parameter. */
function durationParam(description: string): ParamProperty {
  return { type: "string", pattern: DURATION_PATTERN, description };
}

/** JSON Schema of an ISO 8601 duration parameter that also accepts `null`, to clear the value. */
function nullableDurationParam(description: string): ParamProperty {
  return { type: ["string", "null"], pattern: DURATION_PATTERN, description } as unknown as ParamProperty;
}

/** Creates a mode type; see `scflow/create_mode_type` in the topic `scflow/actions`. */
export const createModeTypeAction: ScflowActionDefinition<CreateModeTypeParams, ModeTypeSummary> = {
  id: "scflow/create_mode_type",
  writes: ["mode_type"],
  title: "Create a mode type",
  description:
    "Creates a mode type, the category of a mode such as road, sea, air, rail, EDI or payment, bound to one flow domain " +
    "(physical, information, financial or service), and returns it. A mode type is the category; a mode is the instance.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the mode type, a string or a map of language to string."),
      domain: { type: "string", enum: [...FLOW_DOMAINS], description: "The flow domain of the modes of this type." },
      description: localizedTextParam("Markdown description of the mode type."),
      tags: tagsParam("Tags of the mode type."),
    },
    required: ["display_name", "domain"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { display_name: await localizedText(context, params.display_name), domain: params.domain };
    if (params.description !== undefined) input.description = await localizedText(context, params.description);
    const tags = unique(params.tags);
    if (tags !== undefined) input.tags = tags;
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.mode_type", input });
    const type = after[0] as unknown as Instance;
    return { id: type.id, display_name: type.display_name as Record<string, string>, domain: type.domain as string };
  },
};

/** Deletes a mode type; see `scflow/delete_mode_type` in the topic `scflow/actions`. */
export const deleteModeTypeAction: ScflowActionDefinition<DeleteModeTypeParams, { id: string }> = {
  id: "scflow/delete_mode_type",
  writes: ["mode_type", "mode", "mode_stop", "flow"],
  destructive: true,
  title: "Delete a mode type",
  description:
    "Deletes a mode type. It is refused while modes have this type, unless cascade is true, which deletes those modes first, " +
    "each with the cascade of scflow/delete_mode: their stops are deleted and their flows are kept, on no mode.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode_type", "Id or name of the mode type to delete."),
      cascade: cascadeParam("When true, also deletes the modes of this type with their stops and notes; their flows are kept."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.mode_type", params.id, params.cascade);
    return { id: params.id };
  },
};

/** Creates a mode; see `scflow/create_mode` in the topic `scflow/actions`. */
export const createModeAction: ScflowActionDefinition<CreateModeParams, ModeSummary> = {
  id: "scflow/create_mode",
  writes: ["mode"],
  title: "Create a mode",
  description:
    "Creates a mode, the instance that says how flows travel (a shuttle, a weekly round trip, an EDI link), of a given mode type, " +
    "with no stop and no flow yet, and returns it. Add its stops with scflow/add_mode_stop and assign flows with scflow/set_flow_mode. " +
    "Set bidirectional to true when the stops are served in both orders; it is false otherwise. The schedule is a free text.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the mode, a string or a map of language to string."),
      type: refParam("mode_type", "Id or name of the mode type."),
      description: localizedTextParam("Markdown description of the mode."),
      schedule: localizedTextParam("Schedule of the mode as a free text, such as every Monday."),
      bidirectional: { type: "boolean", description: "Whether the stops are served in both orders; false when omitted." },
      tags: tagsParam("Tags of the mode."),
    },
    required: ["display_name", "type"],
    additionalProperties: false,
  },
  async run(params, context) {
    const mode = await createMode(context, params);
    return summarizeMode(context, mode);
  },
};

/** Updates a mode; see `scflow/update_mode` in the topic `scflow/actions`. */
export const updateModeAction: ScflowActionDefinition<UpdateModeParams, ModeSummary> = {
  id: "scflow/update_mode",
  writes: ["mode"],
  title: "Update a mode",
  description:
    "Changes the name, description, type, schedule, bidirectional flag or tags of a mode and returns it. Only the given properties " +
    "change; null clears the description or the schedule. A change of type whose domain differs from the items of the flows of the " +
    "mode is refused, and so is making a mode one-way while a flow needs it in the other direction.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode", "Id or name of the mode to update."),
      display_name: localizedTextParam("New display name; each given language replaces the same language, the others are kept."),
      description: nullableLocalizedTextParam("New Markdown description; same language rule as name. null removes the description."),
      type: refParam("mode_type", "Id or name of the new mode type."),
      schedule: nullableLocalizedTextParam("New schedule; same language rule as name. null removes the schedule."),
      bidirectional: { type: "boolean", description: "Whether the stops are served in both orders." },
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const patch: Record<string, unknown> = {};
    if (params.display_name !== undefined) patch.display_name = { set: await localizedText(context, params.display_name) };
    if (params.description !== undefined) {
      patch.description = params.description === null ? null : { set: await localizedText(context, params.description) };
    }
    if (params.type !== undefined) patch.type = params.type;
    if (params.schedule !== undefined) {
      patch.schedule = params.schedule === null ? null : { set: await localizedText(context, params.schedule) };
    }
    if (params.bidirectional !== undefined) patch.bidirectional = params.bidirectional;
    const tags = unique(params.tags);
    if (tags !== undefined) patch.tags = tags;

    const { after } = await context.runCommand(context.locator, { kind: "update", schema: "scflow.mode", filters: { id: params.id }, input: patch });
    if (params.bidirectional === false) await checkModeServesFlows(context, params.id);
    return summarizeMode(context, after[0] as unknown as Instance);
  },
};

/** Deletes a mode; see `scflow/delete_mode` in the topic `scflow/actions`. */
export const deleteModeAction: ScflowActionDefinition<DeleteModeParams, { id: string }> = {
  id: "scflow/delete_mode",
  writes: ["mode", "mode_stop", "flow"],
  destructive: true,
  title: "Delete a mode",
  description:
    "Deletes a mode with its stops and notes, and returns its id. It is refused while flows travel on the mode, unless cascade is " +
    "true, which keeps those flows and clears their mode.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode", "Id or name of the mode to delete."),
      cascade: cascadeParam("When true, also clears the mode of the flows that travel on it; the flows are kept."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    const flows = await query(context, "scflow.flow", { mode: params.id });
    if (flows.length > 0 && params.cascade !== true) {
      const mode = await loadInstance(context, "scflow.mode", params.id);
      throw new Error(`mode "${labelOf(mode)}" carries ${flows.length} flow(s): delete it with cascade true to clear their mode`);
    }
    await deleteById(context, "scflow.mode", params.id);
    return { id: params.id };
  },
};

/** Adds a stop to a mode; see `scflow/add_mode_stop` in the topic `scflow/actions`. */
export const addModeStopAction: ScflowActionDefinition<AddModeStopParams, ModeStopSummary> = {
  id: "scflow/add_mode_stop",
  writes: ["mode_stop"],
  title: "Add a stop to a mode",
  description:
    "Adds a stop at an actor to a mode, at the position given by sequence (1 for the first stop), or after the last stop when " +
    "sequence is omitted, and returns it. The stops from that position on move one place down. An actor may have several stops on " +
    "one mode, such as the start and the end of a round trip. lead_time is the ISO 8601 duration of the leg from the previous stop, " +
    "such as P2D or PT4H30M, and is ignored on the first stop; reverse_lead_time is the duration of the same leg backwards on a " +
    "bidirectional mode, equal to lead_time when omitted.",
  parameters: {
    type: "object",
    properties: {
      mode: refParam("mode", "Id or name of the mode."),
      actor: refParam("actor", "Id or name of the actor of the stop."),
      sequence: { type: "integer", minimum: 1, description: "Position of the stop, from 1; after the last stop when omitted." },
      lead_time: durationParam("ISO 8601 duration of the leg from the previous stop to this one."),
      reverse_lead_time: durationParam("ISO 8601 duration of the leg from this stop back to the previous one; lead_time when omitted."),
      tags: tagsParam("Tags of the stop."),
    },
    required: ["mode", "actor"],
    additionalProperties: false,
  },
  async run(params, context) {
    const stop = await addModeStop(context, params);
    return summarizeStop(stop);
  },
};

/** Moves a stop or changes its lead times; see `scflow/update_mode_stop` in the topic `scflow/actions`. */
export const updateModeStopAction: ScflowActionDefinition<UpdateModeStopParams, ModeStopSummary> = {
  id: "scflow/update_mode_stop",
  writes: ["mode_stop"],
  title: "Update a stop of a mode",
  description:
    "Moves a stop of a mode to another position, given by sequence, or changes its lead times or tags, and returns it. The other " +
    "stops keep their order. null clears a lead time. A move after which the mode no longer serves one of its flows, a stop of the " +
    "source before a stop of the destination, is refused.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode_stop", "Id of the stop."),
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
    const stop = await loadInstance(context, "scflow.mode_stop", params.id);
    const modeId = stop.mode as string;
    const patch: Record<string, unknown> = {};
    if (params.lead_time !== undefined) patch.lead_time = params.lead_time;
    if (params.reverse_lead_time !== undefined) patch.reverse_lead_time = params.reverse_lead_time;
    const tags = unique(params.tags);
    if (tags !== undefined) patch.tags = tags;
    if (Object.keys(patch).length > 0) {
      await context.runCommand(context.locator, { kind: "update", schema: "scflow.mode_stop", filters: { id: stop.id }, input: patch });
    }
    if (params.sequence !== undefined && params.sequence !== stop.sequence) {
      const others = (await stopsOf(context, modeId)).filter((other) => other.id !== stop.id);
      if (params.sequence > others.length + 1) {
        throw new Error(`sequence ${params.sequence} is beyond the ${others.length + 1} stops of the mode`);
      }
      others.splice(params.sequence - 1, 0, stop);
      await renumber(context, others);
      await checkModeServesFlows(context, modeId);
    }
    return summarizeStop(await loadInstance(context, "scflow.mode_stop", stop.id));
  },
};

/** Removes a stop from a mode; see `scflow/remove_mode_stop` in the topic `scflow/actions`. */
export const removeModeStopAction: ScflowActionDefinition<RemoveModeStopParams, { id: string }> = {
  id: "scflow/remove_mode_stop",
  writes: ["mode_stop"],
  destructive: true,
  title: "Remove a stop from a mode",
  description:
    "Removes a stop from its mode and returns its id; the following stops move one place up. It is refused when a flow of the mode " +
    "needs the stop: its source or destination would no longer be a stop, or no stop of its source would come before a stop of its " +
    "destination. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode_stop", "Id of the stop to remove."),
      cascade: cascadeParam("Has no effect: nothing depends on a stop but its notes, which are always deleted with it."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    const stop = await loadInstance(context, "scflow.mode_stop", params.id);
    const modeId = stop.mode as string;
    await deleteById(context, "scflow.mode_stop", stop.id);
    await renumber(context, await stopsOf(context, modeId));
    await checkModeServesFlows(context, modeId);
    return { id: params.id };
  },
};

/** Assigns or clears the mode of a flow; see `scflow/set_flow_mode` in the topic `scflow/actions`. */
export const setFlowModeAction: ScflowActionDefinition<SetFlowModeParams, FlowSummary> = {
  id: "scflow/set_flow_mode",
  writes: ["flow"],
  title: "Set the mode of a flow",
  description:
    "Makes a flow travel on a mode, or on none with null, and returns the flow. A flow travels on at most one mode, so this replaces " +
    "its mode. The source and the destination of the flow must be stops of the mode, a stop of the source before a stop of the " +
    "destination unless the mode is bidirectional; a bidirectional flow also needs the other direction. The item of the flow must " +
    "be in the domain of the mode type.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("flow", "Id of the flow."),
      mode: nullableRefParam("mode", "Id or name of the mode, or null to take the flow off its mode."),
    },
    required: ["id", "mode"],
    additionalProperties: false,
  },
  async run(params, context) {
    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.flow",
      filters: { id: params.id },
      input: { mode: params.mode },
    });
    if (params.mode !== null) await checkModeServesFlows(context, params.mode, [params.id]);
    return summarizeFlow(after[0] as unknown as Instance);
  },
};

/** Creates a mode from flows; see `scflow/create_mode_from_flows` in the topic `scflow/actions`. */
export const createModeFromFlowsAction: ScflowActionDefinition<CreateModeFromFlowsParams, ModeSummary> = {
  id: "scflow/create_mode_from_flows",
  writes: ["mode", "mode_stop", "flow"],
  title: "Create a mode from flows",
  description:
    "Creates a mode of a given type for flows that share their source and their destination and travel on no mode yet, with two " +
    "stops, the source then the destination, makes the flows travel on it and returns it. The items of the flows must be in the " +
    "domain of the mode type. lead_time is the ISO 8601 duration from the source to the destination. The mode is bidirectional " +
    "when bidirectional is true, or when it is omitted and one of the flows is bidirectional.",
  parameters: {
    type: "object",
    properties: {
      flows: { type: "array", minItems: 1, items: { type: "string", ref: "flow" }, description: "Ids of the flows, at least one." } as unknown as ParamProperty,
      type: refParam("mode_type", "Id or name of the mode type."),
      display_name: localizedTextParam("Display name of the mode, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the mode."),
      schedule: localizedTextParam("Schedule of the mode as a free text, such as every Monday."),
      bidirectional: { type: "boolean", description: "Whether the mode serves its stops in both orders; true when omitted and a flow is bidirectional." },
      lead_time: durationParam("ISO 8601 duration from the source to the destination."),
      reverse_lead_time: durationParam("ISO 8601 duration from the destination back to the source; lead_time when omitted."),
      tags: tagsParam("Tags of the mode."),
    },
    required: ["flows", "type", "display_name"],
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
      if (flow.mode) {
        throw new Error(`flow "${flow.id}" already travels on a mode: take it off with scflow/set_flow_mode first`);
      }
    }
    const bidirectional = params.bidirectional ?? flows.some((flow) => flow.bidirectional === true);
    const mode = await createMode(context, { ...params, bidirectional });
    await addModeStop(context, { mode: mode.id, actor: first.source as string });
    await addModeStop(context, {
      mode: mode.id,
      actor: first.destination as string,
      ...(params.lead_time === undefined ? {} : { lead_time: params.lead_time }),
      ...(params.reverse_lead_time === undefined ? {} : { reverse_lead_time: params.reverse_lead_time }),
    });
    for (const id of flowIds) {
      await context.runCommand(context.locator, { kind: "update", schema: "scflow.flow", filters: { id }, input: { mode: mode.id } });
    }
    await checkModeServesFlows(context, mode.id);
    return summarizeMode(context, mode);
  },
};

/** Describes a mode with the lead times of its flows; see `scflow/inspect_mode` in the topic `scflow/actions`. */
export const inspectModeAction: ScflowActionDefinition<InspectModeParams, InspectModeResult> = {
  id: "scflow/inspect_mode",
  writes: [],
  kind: "read",
  title: "Inspect a mode",
  description:
    "Describes a mode: its type and domain, its stops in order with their lead times, and each of its flows with its lead time, the " +
    "sum of the lead times of the legs from a stop of its source to a stop of its destination; a bidirectional flow also has the " +
    "lead time back. A lead time is null when a leg of the path has none. idle_stops lists the stops that are the end of no flow " +
    "of the mode, which is allowed. It changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("mode", "Id or name of the mode."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    const mode = await loadInstance(context, "scflow.mode", params.id);
    const type = await loadInstance(context, "scflow.mode_type", mode.type);
    const summary = await summarizeMode(context, mode);
    const stops = await stopsOf(context, mode.id);
    const flows = await query(context, "scflow.flow", { mode: mode.id });
    const bidirectional = mode.bidirectional === true;
    const leadTime = (from: string, to: string) => leadTimeOnMode(stopInputs(stops), from, to, bidirectional)?.lead_time ?? null;

    const lead_times = flows.map((flow): ModeFlowLeadTime => {
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
    const idle_stops = stops.filter((stop) => !ends.has(stop.actor as string)).map((stop) => stop.id);
    return { ...summary, domain: type.domain as string, lead_times, idle_stops };
  },
};

/** The actions of the lot modes, in catalog order. */
export const MODE_ACTIONS = [
  createModeTypeAction,
  deleteModeTypeAction,
  createModeAction,
  updateModeAction,
  deleteModeAction,
  addModeStopAction,
  updateModeStopAction,
  removeModeStopAction,
  setFlowModeAction,
  createModeFromFlowsAction,
  inspectModeAction,
] as const;

/**
 * Refuses the flows of a mode that it does not serve (rule `mode_serves_flow`): a flow needs a stop
 * of its source before a stop of its destination, or the mode bidirectional, and a bidirectional
 * flow needs the other direction too. A flow whose source or destination is not a stop is left to
 * the declared rule `mode_stops_hold_flow_ends`.
 *
 * @param flowIds The flows to check; every flow of the mode when absent.
 * @throws When the mode does not serve a flow, naming the rule, the mode and the flow.
 */
export async function checkModeServesFlows(context: ActionAccess, modeId: string, flowIds?: readonly string[]): Promise<void> {
  const mode = await loadInstance(context, "scflow.mode", modeId);
  const stops = stopInputs(await stopsOf(context, modeId));
  const actors = new Set(stops.map((stop) => stop.actor));
  const bidirectional = mode.bidirectional === true;
  const flows = (await query(context, "scflow.flow", { mode: modeId })).filter((flow) => !flowIds || flowIds.includes(flow.id));
  for (const flow of flows) {
    const source = flow.source as string;
    const destination = flow.destination as string;
    if (!actors.has(source) || !actors.has(destination)) continue;
    const served =
      leadTimeOnMode(stops, source, destination, bidirectional) !== undefined &&
      (flow.bidirectional !== true || leadTimeOnMode(stops, destination, source, bidirectional) !== undefined);
    if (!served) {
      const direction = flow.bidirectional === true ? "in both directions" : "from its source to its destination";
      throw new Error(`rule mode_serves_flow: mode "${labelOf(mode)}" does not serve flow "${flow.id}" ${direction}`);
    }
  }
}

/** The stops of a mode, in the order of their sequence. */
export async function stopsOf(context: ActionAccess, modeId: string): Promise<Instance[]> {
  const stops = await query(context, "scflow.mode_stop", { mode: modeId });
  return stops.sort((a, b) => (a.sequence as number) - (b.sequence as number));
}

async function createMode(context: ActionAccess, params: CreateModeParams): Promise<Instance> {
  const input: Record<string, unknown> = {
    display_name: await localizedText(context, params.display_name),
    type: params.type,
    bidirectional: params.bidirectional ?? false,
  };
  if (params.description !== undefined) input.description = await localizedText(context, params.description);
  if (params.schedule !== undefined) input.schedule = await localizedText(context, params.schedule);
  const tags = unique(params.tags);
  if (tags !== undefined) input.tags = tags;
  const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.mode", input });
  return after[0] as unknown as Instance;
}

async function addModeStop(context: ActionAccess, params: AddModeStopParams): Promise<Instance> {
  // Deleting an actor deletes its stops and may leave a gap in the sequences: closed first.
  const stops = await stopsOf(context, params.mode);
  await renumber(context, stops);
  stops.forEach((stop, index) => (stop.sequence = index + 1));
  const sequence = params.sequence ?? stops.length + 1;
  if (sequence > stops.length + 1) {
    throw new Error(`sequence ${sequence} is beyond the end of the mode, which has ${stops.length} stop(s)`);
  }
  // Shifted from the last, so that two stops never share a sequence on the way.
  for (const stop of stops.slice(sequence - 1).reverse()) {
    await setSequence(context, stop.id, (stop.sequence as number) + 1);
  }
  // An absent duration is written null: the default of a string, "", is not a duration.
  const input: Record<string, unknown> = {
    mode: params.mode,
    actor: params.actor,
    sequence,
    lead_time: params.lead_time ?? null,
    reverse_lead_time: params.reverse_lead_time ?? null,
  };
  const tags = unique(params.tags);
  if (tags !== undefined) input.tags = tags;
  const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.mode_stop", input });
  return after[0] as unknown as Instance;
}

/** Gives the stops their position in the list as sequence, from 1. */
async function renumber(context: ActionAccess, stops: readonly Instance[]): Promise<void> {
  for (const [index, stop] of stops.entries()) {
    if (stop.sequence !== index + 1) await setSequence(context, stop.id, index + 1);
  }
}

async function setSequence(context: ActionAccess, id: string, sequence: number): Promise<void> {
  await context.runCommand(context.locator, { kind: "update", schema: "scflow.mode_stop", filters: { id }, input: { sequence } });
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

async function summarizeMode(context: ActionAccess, mode: Instance): Promise<ModeSummary> {
  const current = await loadInstance(context, "scflow.mode", mode.id);
  const schedule = current.schedule as Record<string, string> | undefined | null;
  const flows = await query(context, "scflow.flow", { mode: mode.id });
  return {
    id: current.id,
    display_name: current.display_name as Record<string, string>,
    type: current.type as string,
    bidirectional: current.bidirectional === true,
    ...(schedule && Object.keys(schedule).length > 0 ? { schedule } : {}),
    stops: (await stopsOf(context, mode.id)).map(summarizeStop),
    flows: flows.map((flow) => flow.id),
  };
}

function summarizeStop(stop: Instance): ModeStopSummary {
  return {
    id: stop.id,
    mode: stop.mode as string,
    actor: stop.actor as string,
    sequence: stop.sequence as number,
    ...(stop.lead_time ? { lead_time: stop.lead_time as string } : {}),
    ...(stop.reverse_lead_time ? { reverse_lead_time: stop.reverse_lead_time as string } : {}),
  };
}

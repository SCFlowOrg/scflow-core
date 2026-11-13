import type { MclAccess } from "@scfloworg/core";
import type { ActionAccess } from "./actions/params.js";
import { holdItem } from "./actions/items.js";
import { type Instance } from "./actions/refs.js";

/** The two actors a flow connects, by id. */
export interface FlowEndsInput {
  /** Id of the actor the flow starts from. */
  source: string;
  /** Id of the actor the flow arrives at. */
  destination: string;
}

/** The input of {@link createFlow}. */
export interface CreateFlowInput extends FlowEndsInput {
  /**
   * Id of the item the flow carries. Required when the flow joins an actor and
   * one of its child actors, in either direction.
   */
  item?: string;
  /**
   * Whether the flow is bidirectional, that is carries items in both
   * directions between the two actors. `false` when absent.
   */
  bidirectional?: boolean;
  /** Display name of the flow, one entry per language. The flow has no name when absent. */
  display_name?: Record<string, string>;
  /** Markdown description of the flow, one entry per language. The flow has none when absent. */
  description?: Record<string, string>;
  /** Tags of the flow. */
  tags?: string[];
}

/** The input of {@link setFlowItem}. */
export interface SetFlowItemInput {
  /** Id of the flow. */
  flow: string;
  /** Id of the item the flow carries. */
  item: string;
}

/**
 * Lists the flow domains common to two actors, without writing anything.
 *
 * The common domains are the intersection of the `domains` of the types of
 * `source` and `destination`, in the declaration order of `flow_domain`.
 * An interface uses it to accept or refuse a drag and drop between two actors:
 * an empty list refuses it.
 *
 * @returns The common flow domains; an empty list when the actors share none.
 * @throws When an actor does not exist.
 */
export async function getCommonFlowDomains(
  mcl: MclAccess,
  locator: string,
  input: FlowEndsInput,
): Promise<string[]> {
  const sourceDomains = await domainsOfActor(mcl, locator, input.source);
  const destinationDomains = await domainsOfActor(mcl, locator, input.destination);
  return sourceDomains.filter((domain) => destinationDomains.includes(domain));
}

/**
 * Creates one flow from `source` to `destination`.
 *
 * The flow takes `input.bidirectional` as its `bidirectional` flag, and
 * `input.display_name`, `input.description` and `input.tags` when they are
 * given. Flows already linking the two actors are neither reused nor reported:
 * the flow is always created.
 *
 * When `input.item` is given, an `item_at_actor` is created for each end that
 * lacks one, as the rule `flow_ends_hold_item` requires. The engine refuses a
 * breach of the rules of a flow, such as `internal_flow_item` and
 * `carried_item_domain`.
 *
 * @returns The created flow.
 * @throws When an actor or the item does not exist, or when a rule is broken.
 */
export async function createFlow(
  mcl: MclAccess,
  locator: string,
  input: CreateFlowInput,
): Promise<Record<string, unknown>> {
  const { source, destination, item, bidirectional = false, display_name, description, tags } = input;

  if (item !== undefined) {
    await holdItem(onDataset(mcl, locator), source, item);
    await holdItem(onDataset(mcl, locator), destination, item);
  }

  const { after } = await mcl.runCommand(locator, {
    kind: "create",
    schema: "scflow.flow",
    input: {
      source,
      destination,
      bidirectional,
      ...(item === undefined ? {} : { item }),
      ...(display_name === undefined ? {} : { display_name: { ...display_name } }),
      ...(description === undefined ? {} : { description: { ...description } }),
      ...(tags === undefined ? {} : { tags: [...tags] }),
    },
  });
  return after[0] as unknown as Record<string, unknown>;
}

/**
 * Sets the item of a flow.
 *
 * An `item_at_actor` is created for each end that lacks one, as the rule
 * `flow_ends_hold_item` requires. The `item` of a flow is `set_once`, so another
 * item is refused and the same item changes nothing. The engine refuses a breach
 * of the rule `carried_item_domain`.
 *
 * @returns The flow.
 * @throws When the flow or the item does not exist, or when a rule is broken.
 */
export async function setFlowItem(
  mcl: MclAccess,
  locator: string,
  input: SetFlowItemInput,
): Promise<Record<string, unknown>> {
  const flow = await loadInstance(mcl, locator, "scflow.flow", input.flow);
  await holdItem(onDataset(mcl, locator), flow.source as string, input.item);
  await holdItem(onDataset(mcl, locator), flow.destination as string, input.item);

  const { after } = await mcl.runCommand(locator, {
    kind: "update",
    schema: "scflow.flow",
    filters: { id: flow.id },
    input: { item: input.item },
  });
  return after[0] as unknown as Record<string, unknown>;
}

/** The access of the actions on the dataset `locator`. */
function onDataset(mcl: MclAccess, locator: string): ActionAccess {
  return { locator, runCommand: (at, command) => mcl.runCommand(at, command), runScript: (at, script) => mcl.runScript(at, script) };
}

/** Reads one instance by id; the id of a missing instance is quoted in the error. */
async function loadInstance(mcl: MclAccess, locator: string, schema: string, id: string): Promise<Instance> {
  const { after } = await mcl.runCommand(locator, { kind: "query", schema, filters: { id } });
  if (after.length === 0) {
    throw new Error(`${schema} "${id}" does not exist`);
  }
  return after[0] as unknown as Instance;
}

async function domainsOfActor(mcl: MclAccess, locator: string, actorId: string): Promise<string[]> {
  const actor = await loadInstance(mcl, locator, "scflow.actor", actorId);
  const types = await mcl.runCommand(locator, {
    kind: "query",
    schema: "scflow.actor_type",
    filters: { id: actor.type as string },
  });
  const actorType = types.after[0] as unknown as { domains: string[] };
  return actorType.domains;
}

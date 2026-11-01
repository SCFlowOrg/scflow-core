import type { MclAccess } from "@scfloworg/core";
import { assertCarryable, holdItem } from "./actions/items.js";
import { labelOf, type Instance } from "./actions/refs.js";

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
 * given. The domains of the two actors are not checked. Flows already linking
 * the two actors are neither reused nor reported: the flow is always created.
 *
 * A flow between an actor and one of its child actors, in either direction, is
 * a transport inside the actor and must carry an item (rule
 * `internal_flow_item`). When `input.item` is given, its domain must be among
 * the domains of both actors (rule `carried_item_domain`), and the flow makes
 * the source and the destination hold it (rule `flow_ends_hold_item`): an
 * `item_at_actor` is created for each end that lacks one. Everything is checked
 * before anything is written.
 *
 * @returns The created flow.
 * @throws When an actor or the item does not exist, when a flow between an actor
 *   and its child gives no item, or when the domain of the item is not among
 *   the domains of an end.
 */
export async function createFlow(
  mcl: MclAccess,
  locator: string,
  input: CreateFlowInput,
): Promise<Record<string, unknown>> {
  const { source, destination, item, bidirectional = false, display_name, description, tags } = input;

  const sourceActor = await loadInstance(mcl, locator, "actor", source);
  const destinationActor = await loadInstance(mcl, locator, "actor", destination);

  if (item === undefined && isParentChild(sourceActor, destinationActor)) {
    throw new Error(
      `a flow between "${labelOf(sourceActor)}" and "${labelOf(destinationActor)}", one being the parent of the other, must carry an item`,
    );
  }
  const itemInstance = item === undefined ? undefined : await loadInstance(mcl, locator, "item", item);
  if (itemInstance !== undefined) {
    await assertCarryable(mcl, locator, sourceActor, destinationActor, itemInstance);
  }

  const { after } = await mcl.runCommand(locator, {
    kind: "create",
    schema: "flow",
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
  if (itemInstance !== undefined) {
    await holdItem(mcl, locator, sourceActor, itemInstance);
    await holdItem(mcl, locator, destinationActor, itemInstance);
  }
  return after[0] as unknown as Record<string, unknown>;
}

/**
 * Sets the item of a flow that carries none.
 *
 * The item of a flow never changes and is never removed, so the call throws
 * when the flow carries another item, and changes nothing when it already
 * carries `input.item`. The domain of the item must be among the domains of both
 * ends of the flow (rule `carried_item_domain`), and an `item_at_actor` is
 * created for each end that lacks one (rule `flow_ends_hold_item`).
 *
 * @returns The flow.
 * @throws When the flow or the item does not exist, when the flow carries another
 *   item, or when the domain of the item is not among the domains of an end.
 */
export async function setFlowItem(
  mcl: MclAccess,
  locator: string,
  input: SetFlowItemInput,
): Promise<Record<string, unknown>> {
  const flow = await loadInstance(mcl, locator, "flow", input.flow);
  const item = await loadInstance(mcl, locator, "item", input.item);

  const current = flow.item as string | undefined | null;
  if (current === item.id) {
    return flow;
  }
  if (current) {
    throw new Error(`flow "${flow.id}" already carries an item: the item of a flow never changes and is never removed`);
  }

  const source = await loadInstance(mcl, locator, "actor", flow.source as string);
  const destination = await loadInstance(mcl, locator, "actor", flow.destination as string);
  await assertCarryable(mcl, locator, source, destination, item);

  const { after } = await mcl.runCommand(locator, {
    kind: "update",
    schema: "flow",
    filters: { id: flow.id },
    input: { item: item.id },
  });
  await holdItem(mcl, locator, source, item);
  await holdItem(mcl, locator, destination, item);
  return after[0] as unknown as Record<string, unknown>;
}

/** True when one actor is the parent of the other. */
function isParentChild(first: Instance, second: Instance): boolean {
  return first.parent_actor === second.id || second.parent_actor === first.id;
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
  const actor = await loadInstance(mcl, locator, "actor", actorId);
  const types = await mcl.runCommand(locator, {
    kind: "query",
    schema: "actor_type",
    filters: { id: actor.type as string },
  });
  const actorType = types.after[0] as unknown as { domains: string[] };
  return actorType.domains;
}

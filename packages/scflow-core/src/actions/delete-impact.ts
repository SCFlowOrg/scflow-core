import { type Instance } from "./refs.js";
import { type ActionAccess } from "./params.js";

/**
 * Every instance that a deletion can reach, read once so that the dependency
 * closure is computed in memory.
 */
export interface Snapshot {
  actors: Instance[];
  flows: Instance[];
  items: Instance[];
  /** The `item_at_actor` records. */
  held: Instance[];
  transformations: Instance[];
  /** The `transformation_line` instances. */
  lines: Instance[];
  conversions: Instance[];
  notes: Instance[];
}

/** The ids of the instances that a deletion removes, by kind. */
export interface DeletionSet {
  actors: Set<string>;
  flows: Set<string>;
  items: Set<string>;
  held: Set<string>;
  transformations: Set<string>;
  lines: Set<string>;
  conversions: Set<string>;
}

/** Reads the instances that a deletion can reach. */
export async function loadSnapshot(context: ActionAccess): Promise<Snapshot> {
  const all = async (schema: string): Promise<Instance[]> => {
    const { after } = await context.runCommand(context.locator, { kind: "query", schema });
    return after as unknown as Instance[];
  };
  return {
    actors: await all("scflow.actor"),
    flows: await all("scflow.flow"),
    items: await all("scflow.item"),
    held: await all("scflow.item_at_actor"),
    transformations: await all("scflow.transformation"),
    lines: await all("scflow.transformation_line"),
    conversions: await all("scflow.conversion"),
    notes: await all("scflow.note"),
  };
}

/** An empty deletion set. */
export function newDeletionSet(): DeletionSet {
  return {
    actors: new Set(),
    flows: new Set(),
    items: new Set(),
    held: new Set(),
    transformations: new Set(),
    lines: new Set(),
    conversions: new Set(),
  };
}

/** Adds actors to the set, each with all its descendants through `parent_actor`. */
export function addActorTrees(snapshot: Snapshot, set: DeletionSet, actorIds: Iterable<string>): void {
  const childrenOf = new Map<string, string[]>();
  for (const actor of snapshot.actors) {
    const parent = actor.parent_actor as string | undefined | null;
    if (parent) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), actor.id]);
    }
  }
  const pending = [...actorIds];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (set.actors.has(id)) {
      continue;
    }
    set.actors.add(id);
    pending.push(...(childrenOf.get(id) ?? []));
  }
}

/**
 * Adds to the set everything that depends on what it already holds: the flows of its actors and
 * the flows that carry its items, what its actors and items are held as, the transformations of its
 * actors, the lines of its transformations and held items, and the conversions of its actors and items.
 *
 * One pass is enough: each kind depends only on the kinds computed before it.
 */
export function closeDeletionSet(snapshot: Snapshot, set: DeletionSet): void {
  for (const flow of snapshot.flows) {
    if (
      set.actors.has(flow.source as string) ||
      set.actors.has(flow.destination as string) ||
      set.items.has(flow.item as string)
    ) {
      set.flows.add(flow.id);
    }
  }
  for (const record of snapshot.held) {
    if (set.actors.has(record.actor as string) || set.items.has(record.item as string)) {
      set.held.add(record.id);
    }
  }
  for (const transformation of snapshot.transformations) {
    if (set.actors.has(transformation.actor as string)) {
      set.transformations.add(transformation.id);
    }
  }
  for (const line of snapshot.lines) {
    if (set.transformations.has(line.transformation as string) || set.held.has(line.held_item as string)) {
      set.lines.add(line.id);
    }
  }
  for (const conversion of snapshot.conversions) {
    if (
      set.actors.has(conversion.actor as string) ||
      set.items.has(conversion.from_item as string) ||
      set.items.has(conversion.to_item as string)
    ) {
      set.conversions.add(conversion.id);
    }
  }
}

/** Deletes items with the held records and the flows that reference them and the lines of those records. */
export async function deleteItems(
  context: ActionAccess,
  snapshot: Snapshot,
  itemIds: readonly string[],
): Promise<void> {
  const set = newDeletionSet();
  for (const id of itemIds) {
    set.items.add(id);
  }
  closeDeletionSet(snapshot, set);
  await executeDeletion(context, snapshot, set);
}

/** Deletes transformations with their lines. */
export async function deleteTransformations(
  context: ActionAccess,
  snapshot: Snapshot,
  transformationIds: readonly string[],
): Promise<void> {
  const set = newDeletionSet();
  for (const id of transformationIds) {
    set.transformations.add(id);
  }
  closeDeletionSet(snapshot, set);
  await executeDeletion(context, snapshot, set);
}

/** Deletes conversions. */
export async function deleteConversions(
  context: ActionAccess,
  snapshot: Snapshot,
  conversionIds: readonly string[],
): Promise<void> {
  const set = newDeletionSet();
  for (const id of conversionIds) {
    set.conversions.add(id);
  }
  await executeDeletion(context, snapshot, set);
}

/** The ids of every instance of the set, whatever its kind. */
export function allIds(set: DeletionSet): Set<string> {
  return new Set([
    ...set.actors,
    ...set.flows,
    ...set.items,
    ...set.held,
    ...set.transformations,
    ...set.lines,
    ...set.conversions,
  ]);
}

/** The notes that annotate one of the given entities. */
export function notesOn(snapshot: Snapshot, ids: ReadonlySet<string>): Instance[] {
  return snapshot.notes.filter((note) => ids.has(note.annotated as string));
}

/**
 * Deletes the instances of the set in dependency order: lines, conversions, held items,
 * transformations, flows, actors from the deepest to the root, then items. The notes of a deleted
 * instance go with it.
 */
export async function executeDeletion(
  context: ActionAccess,
  snapshot: Snapshot,
  set: DeletionSet,
): Promise<void> {
  const remove = async (schema: string, ids: readonly string[]): Promise<void> => {
    if (ids.length > 0) {
      await context.runCommand(context.locator, { kind: "delete", schema, filters: { id: { in: ids } } });
    }
  };
  await remove("scflow.transformation_line", [...set.lines]);
  await remove("scflow.conversion", [...set.conversions]);
  await remove("scflow.item_at_actor", [...set.held]);
  await remove("scflow.transformation", [...set.transformations]);
  await remove("scflow.flow", [...set.flows]);
  for (const level of actorsByDepth(snapshot, set.actors)) {
    await remove("scflow.actor", level);
  }
  await remove("scflow.item", [...set.items]);
}

/** The actors of the set grouped by depth in the `parent_actor` tree, the deepest group first. */
function actorsByDepth(snapshot: Snapshot, ids: ReadonlySet<string>): string[][] {
  const parentOf = new Map(snapshot.actors.map((actor) => [actor.id, actor.parent_actor as string | undefined | null]));
  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>();
    for (let current = parentOf.get(id); current && !seen.has(current); current = parentOf.get(current)) {
      seen.add(current);
      depth += 1;
    }
    return depth;
  };
  const levels = new Map<number, string[]>();
  for (const id of ids) {
    const depth = depthOf(id);
    levels.set(depth, [...(levels.get(depth) ?? []), id]);
  }
  return [...levels.entries()].sort(([a], [b]) => b - a).map(([, level]) => level);
}

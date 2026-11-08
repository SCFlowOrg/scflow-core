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
 * Deletes one instance. The relations of the schemas say what happens to what
 * references it: with `on_delete: confirm`, a plain delete is refused and
 * `cascade` removes the referencing instances too.
 */
export async function deleteById(context: ActionAccess, schema: string, id: string, cascade?: boolean): Promise<void> {
  await context.runCommand(context.locator, { kind: "delete", schema, filters: { id }, cascade: cascade === true });
}

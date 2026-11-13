import { labelOf, namesOf, resolveRef, type Instance } from "./refs.js";
import { type ParamProperty, type ScflowActionDefinition } from "./params.js";
import {
  addActorTrees,
  allIds,
  closeDeletionSet,
  loadSnapshot,
  newDeletionSet,
  notesOn,
  type DeletionSet,
  type Snapshot,
} from "./delete-impact.js";

/** The kinds of entity that `scflow/inspect_delete_impact` accepts as a target. */
export const DELETE_TARGET_SCHEMAS = [
  "actor",
  "actor_type",
  "scope",
  "item",
  "item_type",
  "flow",
  "transformation",
  "transformation_type",
  "conversion",
  "item_at_actor",
] as const;

/** The kind of a deletion target. */
export type DeleteTargetSchema = (typeof DELETE_TARGET_SCHEMAS)[number];

/** Parameters of `scflow/inspect_delete_impact`. */
export interface InspectDeleteImpactParams {
  targets: Array<{
    schema: DeleteTargetSchema;
    /** The id or the name of the entity; the id only for a flow and an `item_at_actor`. */
    ref: string;
  }>;
}

/** The result of `scflow/inspect_delete_impact`. */
export interface DeleteImpactResult {
  /** The resolved targets, once each. */
  targets: Array<{ schema: string; id: string; label: string }>;
  /** What a cascading delete removes besides the targets themselves. */
  cascaded: {
    /** `isChild` is set when the parent of the actor is deleted too. */
    actors: Array<{ id: string; label: string; isChild?: boolean }>;
    flows: Array<{ id: string; label: string }>;
    items: Array<{ id: string; label: string }>;
    heldItems: Array<{ id: string; actorName?: string; itemName?: string }>;
    transformations: Array<{ id: string; label: string }>;
    transformationLines: number;
    conversions: Array<{ id: string; label: string }>;
    /** The notes of the targets and of every cascaded entity. */
    notes: number;
  };
  counts: {
    actors: number;
    flows: number;
    items: number;
    heldItems: number;
    transformations: number;
    transformationLines: number;
    conversions: number;
    notes: number;
    total: number;
  };
  /** True when the deletion removes something besides the targets. */
  hasSideEffects: boolean;
}

/** Reports what a cascading delete would remove; see `scflow/inspect_delete_impact` in the topic `scflow/actions`. */
export const inspectDeleteImpactAction: ScflowActionDefinition<InspectDeleteImpactParams, DeleteImpactResult> = {
  id: "scflow/inspect_delete_impact",
  writes: [],
  title: "Inspect the impact of a delete",
  description:
    "Lists what deleting the given entities with cascade true would remove besides the entities themselves: actors, flows, items, " +
    "held items, transformations, transformation lines, conversions and notes, with counts. An entity reached from several targets " +
    "is counted once. It changes nothing.",
  kind: "read",
  parameters: {
    type: "object",
    properties: {
      targets: {
        type: "array",
        minItems: 1,
        description: "The entities to delete.",
        items: {
          type: "object",
          properties: {
            schema: { type: "string", enum: [...DELETE_TARGET_SCHEMAS], description: "The kind of the entity." },
            ref: { type: "string", minLength: 1, description: "Id or name of the entity; the id only for a flow and an item_at_actor." },
          },
          required: ["schema", "ref"],
          additionalProperties: false,
        },
      } as unknown as ParamProperty,
    },
    required: ["targets"],
    additionalProperties: false,
  },
  async run(params, context) {
    const snapshot = await loadSnapshot(context);
    const set = newDeletionSet();
    const direct = newDeletionSet();
    const targets: DeleteImpactResult["targets"] = [];
    const targetIds = new Set<string>();

    for (const [index, target] of params.targets.entries()) {
      const instance = await resolveRef(context, `scflow.${target.schema}`, target.ref, `targets[${index}].ref`);
      if (targetIds.has(instance.id)) {
        continue;
      }
      targetIds.add(instance.id);
      targets.push({ schema: target.schema, id: instance.id, label: labelTarget(snapshot, target.schema, instance) });
      addTarget(snapshot, set, direct, target.schema, instance);
    }
    closeDeletionSet(snapshot, set);

    const noteCount = notesOn(snapshot, new Set([...allIds(set), ...targetIds])).length;
    return describe(snapshot, set, direct, targets, noteCount);
  },
};

/** The actions of the lot inspection, in catalog order. */
export const INSPECT_ACTIONS = [inspectDeleteImpactAction] as const;

/**
 * Adds a target to the deletion set. `direct` records the entities named as targets, which the
 * result does not list as cascaded.
 */
function addTarget(
  snapshot: Snapshot,
  set: DeletionSet,
  direct: DeletionSet,
  schema: DeleteTargetSchema,
  instance: Instance,
): void {
  switch (schema) {
    case "actor":
      direct.actors.add(instance.id);
      addActorTrees(snapshot, set, [instance.id]);
      break;
    case "actor_type":
      addActorTrees(snapshot, set, idsWhere(snapshot.actors, "type", instance.id));
      break;
    case "scope":
      addActorTrees(snapshot, set, idsWhere(snapshot.actors, "scope", instance.id));
      break;
    case "item":
      direct.items.add(instance.id);
      set.items.add(instance.id);
      break;
    case "item_type":
      idsWhere(snapshot.items, "type", instance.id).forEach((id) => set.items.add(id));
      break;
    case "flow":
      direct.flows.add(instance.id);
      set.flows.add(instance.id);
      break;
    case "transformation":
      direct.transformations.add(instance.id);
      set.transformations.add(instance.id);
      break;
    case "transformation_type":
      idsWhere(snapshot.transformations, "type", instance.id).forEach((id) => set.transformations.add(id));
      break;
    case "conversion":
      direct.conversions.add(instance.id);
      set.conversions.add(instance.id);
      break;
    case "item_at_actor":
      direct.held.add(instance.id);
      set.held.add(instance.id);
      break;
  }
}

function idsWhere(instances: Instance[], property: string, value: string): string[] {
  return instances.filter((instance) => instance[property] === value).map((instance) => instance.id);
}

/** The label of a target; a flow has no name, so it is described by its ends. */
function labelTarget(snapshot: Snapshot, schema: DeleteTargetSchema, instance: Instance): string {
  switch (schema) {
    case "flow":
      return labelFlow(snapshot, instance);
    case "conversion":
      return labelConversion(snapshot, instance);
    case "item_at_actor":
      return `${labelIn(snapshot.items, instance.item)} at ${labelIn(snapshot.actors, instance.actor)}`;
    default:
      return labelOf(instance);
  }
}

function labelFlow(snapshot: Snapshot, flow: Instance): string {
  return `${labelIn(snapshot.actors, flow.source)} → ${labelIn(snapshot.actors, flow.destination)}`;
}

/** The label of a conversion: its name, or its two items when it has none. */
function labelConversion(snapshot: Snapshot, conversion: Instance): string {
  return namesOf(conversion)[0] ?? `${labelIn(snapshot.items, conversion.from_item)} → ${labelIn(snapshot.items, conversion.to_item)}`;
}

/** The label of the instance with the given id, or the id itself when it is not in the list. */
function labelIn(instances: Instance[], id: unknown): string {
  const found = instances.find((instance) => instance.id === id);
  return found ? labelOf(found) : String(id);
}

/** Builds the result from the deletion set, leaving out the entities named as targets. */
function describe(
  snapshot: Snapshot,
  set: DeletionSet,
  direct: DeletionSet,
  targets: DeleteImpactResult["targets"],
  notes: number,
): DeleteImpactResult {
  const cascadedIds = (all: Set<string>, named: Set<string>) => [...all].filter((id) => !named.has(id));
  const find = (instances: Instance[], id: string) => instances.find((instance) => instance.id === id) as Instance;

  const actors = cascadedIds(set.actors, direct.actors).map((id) => {
    const actor = find(snapshot.actors, id);
    const parent = actor.parent_actor as string | undefined | null;
    return { id, label: labelOf(actor), ...(parent && set.actors.has(parent) ? { isChild: true } : {}) };
  });
  const flows = cascadedIds(set.flows, direct.flows).map((id) => ({ id, label: labelFlow(snapshot, find(snapshot.flows, id)) }));
  const items = cascadedIds(set.items, direct.items).map((id) => ({ id, label: labelOf(find(snapshot.items, id)) }));
  const heldItems = cascadedIds(set.held, direct.held).map((id) => {
    const record = find(snapshot.held, id);
    return { id, actorName: labelIn(snapshot.actors, record.actor), itemName: labelIn(snapshot.items, record.item) };
  });
  const transformations = cascadedIds(set.transformations, direct.transformations).map((id) => ({
    id,
    label: labelOf(find(snapshot.transformations, id)),
  }));
  const transformationLines = set.lines.size;
  const conversions = cascadedIds(set.conversions, direct.conversions).map((id) => ({
    id,
    label: labelConversion(snapshot, find(snapshot.conversions, id)),
  }));

  const counts = {
    actors: actors.length,
    flows: flows.length,
    items: items.length,
    heldItems: heldItems.length,
    transformations: transformations.length,
    transformationLines,
    conversions: conversions.length,
    notes,
    total: 0,
  };
  counts.total =
    counts.actors +
    counts.flows +
    counts.items +
    counts.heldItems +
    counts.transformations +
    counts.transformationLines +
    counts.conversions +
    counts.notes;

  return {
    targets,
    cascaded: { actors, flows, items, heldItems, transformations, transformationLines, conversions, notes },
    counts,
    hasSideEffects: counts.total > 0,
  };
}

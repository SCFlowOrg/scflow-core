import { loadInstance, type Instance } from "./refs.js";
import { unique, type ActionAccess, type ScflowActionDefinition, refParam, tagsParam } from "./params.js";

/** Parameters of `scflow/add_tags`. */
export interface AddTagsParams {
  entity: string;
  tags: string[];
}

/** Parameters of `scflow/remove_tags`. */
export interface RemoveTagsParams {
  entity: string;
  tags: string[];
}

/** An entity and its tags, as the tag actions return it. */
export interface TaggedSummary {
  id: string;
  tags: string[];
}

/** The tags of an instance. */
function tagsOf(instance: Instance): string[] {
  return Array.isArray(instance.tags) ? (instance.tags as string[]) : [];
}

/** Writes the tags of an entity, unless they did not change, and summarizes it. */
async function writeTags(context: ActionAccess, entity: Instance, tags: string[]): Promise<TaggedSummary> {
  if (tags.length !== tagsOf(entity).length) {
    await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.annotable",
      filters: { id: entity.id },
      input: { tags },
    });
  }
  return { id: entity.id, tags };
}

/** Appends tags to an entity; see `scflow/add_tags` in `docs/actions.md`. */
export const addTagsAction: ScflowActionDefinition<AddTagsParams, TaggedSummary> = {
  id: "scflow/add_tags",
  writes: ["annotable"],
  title: "Add tags",
  description:
    "Appends tags to an entity of the model (actor, flow, item, scope, type, transformation, conversion...) without removing its existing tags, " +
    "and returns { id, tags }. Tags that the entity already carries are skipped. The entity is given by its id.",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("annotable", "Id of the entity to tag, whatever its kind."),
      tags: { ...tagsParam("Tags to add, at least one."), minItems: 1 },
    },
    required: ["entity", "tags"],
    additionalProperties: false,
  },
  async run(params, context) {
    const entity = await loadInstance(context, "scflow.annotable", params.entity);
    const tags = unique(params.tags) as string[];

    const current = tagsOf(entity);
    return writeTags(context, entity, [...current, ...tags.filter((tag) => !current.includes(tag))]);
  },
};

/** Removes tags from an entity; see `scflow/remove_tags` in `docs/actions.md`. */
export const removeTagsAction: ScflowActionDefinition<RemoveTagsParams, TaggedSummary> = {
  id: "scflow/remove_tags",
  writes: ["annotable"],
  title: "Remove tags",
  description:
    "Removes the given tags from an entity of the model (actor, flow, item, scope, type, transformation, conversion...) and returns { id, tags }. " +
    "Tags that the entity does not carry are ignored. The entity is given by its id.",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("annotable", "Id of the entity to untag, whatever its kind."),
      tags: { ...tagsParam("Tags to remove, at least one."), minItems: 1 },
    },
    required: ["entity", "tags"],
    additionalProperties: false,
  },
  async run(params, context) {
    const entity = await loadInstance(context, "scflow.annotable", params.entity);
    const tags = unique(params.tags) as string[];

    return writeTags(context, entity, tagsOf(entity).filter((tag) => !tags.includes(tag)));
  },
};

/** The actions of the lot tags, in catalog order. */
export const TAG_ACTIONS = [addTagsAction, removeTagsAction] as const;

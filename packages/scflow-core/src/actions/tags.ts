import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";
import { optionalStringList, refParam, tagsParam } from "./params.js";
import { resolveEntity, type Instance } from "./refs.js";

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

/**
 * Reads the required list of tags.
 *
 * @returns The tags without duplicates.
 * @throws When the value is missing, is not a list of non-empty strings, or is empty.
 */
function requireTags(value: unknown): string[] {
  const tags = optionalStringList(value, "tags");
  if (tags === undefined) {
    throw new Error('parameter "tags": expected a list of non-empty strings');
  }
  if (tags.length === 0) {
    throw new Error('parameter "tags": give at least one tag');
  }
  return tags;
}

/** The tags of an instance. */
function tagsOf(instance: Instance): string[] {
  return Array.isArray(instance.tags) ? (instance.tags as string[]) : [];
}

/** Writes the tags of an entity, unless they did not change, and summarizes it. */
async function writeTags(access: MclAccess, locator: string, entity: Instance, tags: string[]): Promise<TaggedSummary> {
  if (tags.length !== tagsOf(entity).length) {
    await access.runCommand(locator, {
      kind: "update",
      schema: "annotable",
      filters: { id: entity.id },
      input: { tags },
    });
  }
  return { id: entity.id, tags };
}

/** Appends tags to an entity; see `scflow/add_tags` in `docs/actions.md`. */
export const addTagsAction: ModelActionDefinition<AddTagsParams, TaggedSummary> = {
  id: "scflow/add_tags",
  title: "Add tags",
  description:
    "Appends tags to an entity of the model (actor, flow, item, scope, type, transformation, conversion...) without removing its existing tags, " +
    "and returns { id, tags }. Tags that the entity already carries are skipped. The entity is given by its id.",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("Id of the entity to tag, whatever its kind."),
      tags: tagsParam("Tags to add, at least one."),
    },
    required: ["entity", "tags"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const entity = await resolveEntity(access, locator, params.entity, "entity");
    const tags = requireTags(params.tags);

    const current = tagsOf(entity);
    return writeTags(access, locator, entity, [...current, ...tags.filter((tag) => !current.includes(tag))]);
  },
};

/** Removes tags from an entity; see `scflow/remove_tags` in `docs/actions.md`. */
export const removeTagsAction: ModelActionDefinition<RemoveTagsParams, TaggedSummary> = {
  id: "scflow/remove_tags",
  title: "Remove tags",
  description:
    "Removes the given tags from an entity of the model (actor, flow, item, scope, type, transformation, conversion...) and returns { id, tags }. " +
    "Tags that the entity does not carry are ignored. The entity is given by its id.",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("Id of the entity to untag, whatever its kind."),
      tags: tagsParam("Tags to remove, at least one."),
    },
    required: ["entity", "tags"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const entity = await resolveEntity(access, locator, params.entity, "entity");
    const tags = requireTags(params.tags);

    return writeTags(access, locator, entity, tagsOf(entity).filter((tag) => !tags.includes(tag)));
  },
};

/** The actions of the lot tags, in catalog order. */
export const TAG_ACTIONS = [addTagsAction, removeTagsAction] as const;

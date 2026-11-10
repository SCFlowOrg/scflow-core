import { type Instance } from "./refs.js";
import { type ScflowActionDefinition, localizedTextParam, nullableLocalizedTextParam, cascadeParam, refParam, tagsParam, unique } from "./params.js";
import { deleteById } from "./delete-impact.js";
import { localizedText } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_conversion`. */
export interface CreateConversionParams {
  actor: string;
  from_item: string;
  to_item: string;
  display_name?: Text;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/update_conversion`. */
export interface UpdateConversionParams {
  id: string;
  display_name?: Text | null;
  description?: Text | null;
  tags?: string[];
}

/** Parameters of `scflow/delete_conversion`. */
export interface DeleteConversionParams {
  id: string;
  cascade?: boolean;
}

/** The result of `scflow/create_conversion` and `scflow/update_conversion`. */
export interface ConversionSummary {
  id: string;
  /** Absent when the conversion has no name. */
  display_name?: Record<string, string>;
  actor: string;
  from_item: string;
  to_item: string;
}

/** Creates a conversion; see `scflow/create_conversion` in `docs/actions.md`. */
export const createConversionAction: ScflowActionDefinition<CreateConversionParams, ConversionSummary> = {
  id: "scflow/create_conversion",
  writes: ["conversion"],
  title: "Create a conversion",
  description:
    "Creates a conversion, which turns one item into another item at an actor, and returns it. The two items must be in the " +
    "same flow domain, and they cannot change afterwards. The name, the description and the tags are optional.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("actor", "Id or name of the actor where the conversion takes place."),
      from_item: refParam("item", "Id or name of the item that is converted."),
      to_item: refParam("item", "Id or name of the item that results; it has the domain of from_item."),
      display_name: localizedTextParam("Display name of the conversion, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the conversion."),
      tags: tagsParam("Tags of the conversion."),
    },
    required: ["actor", "from_item", "to_item"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { actor: params.actor, from_item: params.from_item, to_item: params.to_item };
    if (params.display_name !== undefined) {
      input.display_name = await localizedText(context, params.display_name);
    }
    if (params.description !== undefined) {
      input.description = await localizedText(context, params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.conversion", input });
    return summarizeConversion(after[0] as unknown as Instance);
  },
};

/** Updates the name, the description and the tags of a conversion; see `scflow/update_conversion` in `docs/actions.md`. */
export const updateConversionAction: ScflowActionDefinition<UpdateConversionParams, ConversionSummary> = {
  id: "scflow/update_conversion",
  writes: ["conversion"],
  title: "Update a conversion",
  description:
    "Changes the name, the description or the tags of a conversion and returns it. Only the given properties change; null clears " +
    "a name or a description, and tags replaces the whole list. " +
    "The actor and the two items of a conversion never change: to change them, delete the conversion and create another.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("conversion", "Id or name of the conversion to update."),
      display_name: nullableLocalizedTextParam(
        "New display name; each given language replaces the same language, the others are kept. null removes the name.",
      ),
      description: nullableLocalizedTextParam(
        "New Markdown description; same language rule as name. null removes the description.",
      ),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const patch: Record<string, unknown> = {};

    if (params.display_name !== undefined) {
      patch.display_name = params.display_name === null ? null : { set: await localizedText(context, params.display_name) };
    }
    if (params.description !== undefined) {
      patch.description = params.description === null ? null : { set: await localizedText(context, params.description) };
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      patch.tags = tags;
    }

    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.conversion",
      filters: { id: params.id },
      input: patch,
    });
    return summarizeConversion(after[0] as unknown as Instance);
  },
};

/** Deletes a conversion; see `scflow/delete_conversion` in `docs/actions.md`. */
export const deleteConversionAction: ScflowActionDefinition<DeleteConversionParams, { id: string }> = {
  id: "scflow/delete_conversion",
  writes: ["conversion"],
  destructive: true,
  title: "Delete a conversion",
  description:
    "Deletes a conversion with its notes, and returns its id. The actor and the items are kept. " +
    "The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("conversion", "Id or name of the conversion to delete."),
      cascade: cascadeParam("Has no effect: the notes of a conversion are always deleted with it."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.conversion", params.id);
    return { id: params.id };
  },
};

/** The actions of the lot conversions, in catalog order. */
export const CONVERSION_ACTIONS = [createConversionAction, updateConversionAction, deleteConversionAction] as const;

function summarizeConversion(conversion: Instance): ConversionSummary {
  const summary: ConversionSummary = {
    id: conversion.id,
    actor: conversion.actor as string,
    from_item: conversion.from_item as string,
    to_item: conversion.to_item as string,
  };
  const name = conversion.display_name as Record<string, string> | undefined | null;
  if (name && Object.keys(name).length > 0) {
    summary.display_name = name;
  }
  return summary;
}

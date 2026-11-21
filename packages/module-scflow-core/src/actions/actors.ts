import { type Instance } from "./refs.js";
import { type ActionAccess, type ScflowActionDefinition, localizedTextParam, textParam, nullableRefParam, cascadeParam, refParam, tagsParam, unique } from "./params.js";
import { createActor } from "../actors.js";
import { deleteById } from "./delete-impact.js";
import { localizedText } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_scope`. */
export interface CreateScopeParams {
  name: Text;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/create_actor_type`. */
export interface CreateActorTypeParams {
  name: Text;
  domains?: string[];
  default_scope?: string;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/create_actor`. */
export interface CreateActorParams {
  name: string;
  type: string;
  scope?: string;
  location?: string;
  parent_actor?: string;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/update_actor`. */
export interface UpdateActorParams {
  id: string;
  name?: string;
  description?: Text;
  type?: string;
  scope?: string | null;
  location?: string | null;
  parent_actor?: string | null;
  tags?: string[];
}

/** Parameters of `scflow/delete_actor`. */
export interface DeleteActorParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_actor_type`. */
export interface DeleteActorTypeParams {
  id: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_scope`. */
export interface DeleteScopeParams {
  id: string;
  cascade?: boolean;
}

/** The result of an action that creates or updates an actor. */
export interface ActorSummary {
  id: string;
  name: string;
  /** The name as short as it stays unambiguous, with its parents when another actor shares it; use it to refer to the actor. */
  reference: string;
  type: string;
  scope?: string;
  location?: string;
  parent_actor?: string;
}

/** The result of `scflow/create_scope`. */
export interface ScopeSummary {
  id: string;
  name: Record<string, string>;
}

/** The result of `scflow/create_actor_type`. */
export interface ActorTypeSummary {
  id: string;
  name: Record<string, string>;
  domains: string[];
  default_scope?: string;
}

/** Creates a scope; see `scflow/create_scope` in the topic `scflow/actions`. */
export const createScopeAction: ScflowActionDefinition<CreateScopeParams, ScopeSummary> = {
  id: "scflow/create_scope",
  writes: ["scope"],
  title: "Create a scope",
  description:
    "Creates a scope, a lane that groups actors (for example SOURCE, MAKE, DELIVER or a region), and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Name of the scope, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the scope."),
      tags: tagsParam("Tags of the scope."),
    },
    required: ["name"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { name: await localizedText(context, params.name) };
    if (params.description !== undefined) {
      input.description = await localizedText(context, params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.scope", input });
    const scope = after[0] as unknown as Instance;
    return { id: scope.id, name: scope.name as Record<string, string> };
  },
};

/** Creates an actor type; see `scflow/create_actor_type` in the topic `scflow/actions`. */
export const createActorTypeAction: ScflowActionDefinition<CreateActorTypeParams, ActorTypeSummary> = {
  id: "scflow/create_actor_type",
  writes: ["actor_type"],
  title: "Create an actor type",
  description:
    "Creates an actor type with the flow domains its actors can exchange, and an optional default scope, and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Name of the actor type, a string or a map of language to string."),
      domains: {
        type: "array",
        items: { type: "string", enum: ["physical", "information", "financial", "service"] },
        minItems: 1,
        default: ["physical"],
        description: "Flow domains of the type; physical when omitted.",
      },
      default_scope: refParam("scope", "Id or name of the scope given to the actors of this type that name no scope."),
      description: localizedTextParam("Markdown description of the actor type."),
      tags: tagsParam("Tags of the actor type."),
    },
    required: ["name"],
    additionalProperties: false,
  },
  async run(params, context) {
    const name = await localizedText(context, params.name);
    const domains = unique(params.domains) ?? ["physical"];
    const input: Record<string, unknown> = { name, domains };
    if (params.default_scope !== undefined) {
      input.default_scope = params.default_scope;
    }
    if (params.description !== undefined) {
      input.description = await localizedText(context, params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.actor_type", input });
    const type = after[0] as unknown as Instance;
    return {
      id: type.id,
      name: type.name as Record<string, string>,
      domains: type.domains as string[],
      ...(type.default_scope ? { default_scope: type.default_scope as string } : {}),
    };
  },
};

/** Creates an actor; see `scflow/create_actor` in the topic `scflow/actions`. */
export const createActorAction: ScflowActionDefinition<CreateActorParams, ActorSummary> = {
  id: "scflow/create_actor",
  writes: ["actor"],
  title: "Create an actor",
  description:
    "Creates an actor of a given type in the network, optionally in a scope, at a location and inside a parent actor, and returns it. " +
    "The scope defaults to the default scope of the type; the location has no default.",
  parameters: {
    type: "object",
    properties: {
      name: textParam("Name of the actor, unique among the actors of the same parent actor or, at the root, of the same scope."),
      type: refParam("actor_type", "Id or name of the actor type."),
      scope: refParam("scope", "Id or name of the containing scope; the default scope of the type when omitted."),
      location: refParam("location", "Id or name of the location of the actor; none when omitted."),
      parent_actor: refParam("actor", "Id or name of the parent actor, to nest the actor in a hierarchy."),
      description: localizedTextParam("Markdown description of the actor."),
      tags: tagsParam("Tags of the actor."),
    },
    required: ["name", "type"],
    additionalProperties: false,
  },
  async run(params, context) {
    const name = params.name;
    const input: Parameters<typeof createActor>[2] = { name, type: params.type };
    if (params.scope !== undefined) {
      input.scope = params.scope;
    }
    if (params.location !== undefined) {
      input.location = params.location;
    }
    if (params.parent_actor !== undefined) {
      input.parent_actor = params.parent_actor;
    }
    if (params.description !== undefined) {
      input.description = await localizedText(context, params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    return summarizeActor(context, await createActor(context, context.locator, input) as Instance);
  },
};

/** Updates an actor; see `scflow/update_actor` in the topic `scflow/actions`. */
export const updateActorAction: ScflowActionDefinition<UpdateActorParams, ActorSummary> = {
  id: "scflow/update_actor",
  writes: ["actor"],
  title: "Update an actor",
  description:
    "Changes the name, description, type, scope, location, parent or tags of an actor and returns it. Only the given properties change; " +
    "scope, location and parent_actor accept null to clear the relation. A change that breaks a rule on the held items, " +
    "the flows or the parent of the actor is refused.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("actor", "Id or name of the actor to update."),
      name: textParam("New name of the actor."),
      description: localizedTextParam("New Markdown description; each given language replaces the same language, the others are kept."),
      type: refParam("actor_type", "Id or name of the new actor type."),
      scope: nullableRefParam("scope", "Id or name of the new scope, or null to detach the actor from its scope."),
      location: nullableRefParam("location", "Id or name of the new location, or null to remove the location of the actor."),
      parent_actor: nullableRefParam("actor", "Id or name of the new parent actor, or null to move the actor to the root."),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["id"],
    minProperties: 2,
    additionalProperties: false,
  },
  async run(params, context) {
    const patch: Record<string, unknown> = {};

    if (params.name !== undefined) {
      patch.name = params.name;
    }
    if (params.description !== undefined) {
      patch.description = { set: await localizedText(context, params.description) };
    }
    if (params.type !== undefined) {
      patch.type = params.type;
    }
    if (params.scope !== undefined) {
      patch.scope = params.scope;
    }
    if (params.location !== undefined) {
      patch.location = params.location;
    }
    if (params.parent_actor !== undefined) {
      patch.parent_actor = params.parent_actor;
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      patch.tags = tags;
    }

    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.actor",
      filters: { id: params.id },
      input: patch,
    });
    return summarizeActor(context, after[0] as unknown as Instance);
  },
};

/** Deletes an actor; see `scflow/delete_actor` in the topic `scflow/actions`. */
export const deleteActorAction: ScflowActionDefinition<DeleteActorParams, { id: string }> = {
  id: "scflow/delete_actor",
  writes: ["actor", "flow", "item_at_actor", "transformation", "transformation_line", "conversion", "route_stop"],
  destructive: true,
  title: "Delete an actor",
  description:
    "Deletes an actor. It is refused while child actors, flows, held items, transformations, conversions or stops of routes reference the actor, unless cascade is true, " +
    "which deletes the child actors recursively, the flows incident to the actor and its descendants, the items they hold, " +
    "their transformations and conversions, the stops of routes at them, and the notes of every deleted entity.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("actor", "Id or name of the actor to delete."),
      cascade: cascadeParam("When true, also deletes the descendant actors, the incident flows, the held items, the transformations, the conversions and the notes."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.actor", params.id, params.cascade);
    return { id: params.id };
  },
};

/** Deletes an actor type; see `scflow/delete_actor_type` in the topic `scflow/actions`. */
export const deleteActorTypeAction: ScflowActionDefinition<DeleteActorTypeParams, { id: string }> = {
  id: "scflow/delete_actor_type",
  writes: ["actor", "flow", "item_at_actor", "transformation", "transformation_line", "conversion", "route_stop", "actor_type"],
  destructive: true,
  title: "Delete an actor type",
  description:
    "Deletes an actor type. It is refused while actors have this type, unless cascade is true, which deletes those actors " +
    "first, each with the cascade of scflow/delete_actor.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("actor_type", "Id or name of the actor type to delete."),
      cascade: cascadeParam("When true, also deletes the actors of this type with their descendants, flows, held items, transformations and notes."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.actor_type", params.id, params.cascade);
    return { id: params.id };
  },
};

/** Deletes a scope; see `scflow/delete_scope` in the topic `scflow/actions`. */
export const deleteScopeAction: ScflowActionDefinition<DeleteScopeParams, { id: string }> = {
  id: "scflow/delete_scope",
  writes: ["actor", "flow", "item_at_actor", "transformation", "transformation_line", "conversion", "route_stop", "scope", "actor_type"],
  destructive: true,
  title: "Delete a scope",
  description:
    "Deletes a scope. It is refused while actors are assigned to it, unless cascade is true, which deletes those actors first, " +
    "each with the cascade of scflow/delete_actor. The default scope of an actor type that names the scope is cleared.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("scope", "Id or name of the scope to delete."),
      cascade: cascadeParam("When true, also deletes the actors of this scope with their descendants, flows, held items, transformations and notes."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await deleteById(context, "scflow.scope", params.id, params.cascade);
    return { id: params.id };
  },
};

/** The actions of the lot actors and organization, in catalog order. */
export const ACTOR_ACTIONS = [
  createActorAction,
  updateActorAction,
  deleteActorAction,
  deleteActorTypeAction,
  deleteScopeAction,
  createActorTypeAction,
  createScopeAction,
] as const;

async function summarizeActor(context: ActionAccess, actor: Instance): Promise<ActorSummary> {
  return {
    id: actor.id,
    name: actor.name as string,
    reference: await context.referenceOf("scflow.actor", actor.id),
    type: actor.type as string,
    ...(actor.scope ? { scope: actor.scope as string } : {}),
    ...(actor.location ? { location: actor.location as string } : {}),
    ...(actor.parent_actor ? { parent_actor: actor.parent_actor as string } : {}),
  };
}

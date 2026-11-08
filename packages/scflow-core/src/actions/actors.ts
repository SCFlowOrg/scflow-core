import { labelOf, loadInstance, type Instance } from "./refs.js";
import { type ActionAccess, type ScflowActionDefinition, localizedTextParam, nullableRefParam, cascadeParam, refParam, tagsParam, unique } from "./params.js";
import { createActor } from "../actors.js";
import {
  addActorTrees,
  closeDeletionSet,
  executeDeletion,
  loadSnapshot,
  newDeletionSet,
  type Snapshot,
} from "./delete-impact.js";
import { toLocalized } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_scope`. */
export interface CreateScopeParams {
  display_name: Text;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/create_actor_type`. */
export interface CreateActorTypeParams {
  display_name: Text;
  domains?: string[];
  default_scope?: string;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/create_actor`. */
export interface CreateActorParams {
  display_name: Text;
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
  display_name?: Text;
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
  display_name: Record<string, string>;
  type: string;
  scope?: string;
  location?: string;
  parent_actor?: string;
}

/** The result of `scflow/create_scope`. */
export interface ScopeSummary {
  id: string;
  display_name: Record<string, string>;
}

/** The result of `scflow/create_actor_type`. */
export interface ActorTypeSummary {
  id: string;
  display_name: Record<string, string>;
  domains: string[];
  default_scope?: string;
}

/** Creates a scope; see `scflow/create_scope` in `docs/actions.md`. */
export const createScopeAction: ScflowActionDefinition<CreateScopeParams, ScopeSummary> = {
  id: "scflow/create_scope",
  writes: ["scope"],
  title: "Create a scope",
  description:
    "Creates a scope, a lane that groups actors (for example SOURCE, MAKE, DELIVER or a region), and returns it.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the scope, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the scope."),
      tags: tagsParam("Tags of the scope."),
    },
    required: ["display_name"],
    additionalProperties: false,
  },
  async run(params, context) {
    const input: Record<string, unknown> = { display_name: toLocalized(params.display_name) };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.scope", input });
    const scope = after[0] as unknown as Instance;
    return { id: scope.id, display_name: scope.display_name as Record<string, string> };
  },
};

/** Creates an actor type; see `scflow/create_actor_type` in `docs/actions.md`. */
export const createActorTypeAction: ScflowActionDefinition<CreateActorTypeParams, ActorTypeSummary> = {
  id: "scflow/create_actor_type",
  writes: ["actor_type"],
  title: "Create an actor type",
  description:
    "Creates an actor type with the flow domains its actors can exchange, and an optional default scope, and returns it.",
  parameters: {
    type: "object",
    properties: {
      display_name: localizedTextParam("Display name of the actor type, a string or a map of language to string."),
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
    required: ["display_name"],
    additionalProperties: false,
  },
  async run(params, context) {
    const display_name = toLocalized(params.display_name);
    const domains = unique(params.domains) ?? ["physical"];
    const input: Record<string, unknown> = { display_name, domains };
    if (params.default_scope !== undefined) {
      input.default_scope = params.default_scope;
    }
    if (params.description !== undefined) {
      input.description = toLocalized(params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    const { after } = await context.runCommand(context.locator, { kind: "create", schema: "scflow.actor_type", input });
    const type = after[0] as unknown as Instance;
    return {
      id: type.id,
      display_name: type.display_name as Record<string, string>,
      domains: type.domains as string[],
      ...(type.default_scope ? { default_scope: type.default_scope as string } : {}),
    };
  },
};

/** Creates an actor; see `scflow/create_actor` in `docs/actions.md`. */
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
      display_name: localizedTextParam("Display name of the actor, a string or a map of language to string."),
      type: refParam("actor_type", "Id or name of the actor type."),
      scope: refParam("scope", "Id or name of the containing scope; the default scope of the type when omitted."),
      location: refParam("location", "Id or name of the location of the actor; none when omitted."),
      parent_actor: refParam("actor", "Id or name of the parent actor, to nest the actor in a hierarchy."),
      description: localizedTextParam("Markdown description of the actor."),
      tags: tagsParam("Tags of the actor."),
    },
    required: ["display_name", "type"],
    additionalProperties: false,
  },
  async run(params, context) {
    const display_name = toLocalized(params.display_name);
    const input: Parameters<typeof createActor>[2] = { display_name, type: params.type };
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
      input.description = toLocalized(params.description);
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      input.tags = tags;
    }
    return summarizeActor(await createActor(context, context.locator, input) as Instance);
  },
};

/** Updates an actor; see `scflow/update_actor` in `docs/actions.md`. */
export const updateActorAction: ScflowActionDefinition<UpdateActorParams, ActorSummary> = {
  id: "scflow/update_actor",
  writes: ["actor"],
  title: "Update an actor",
  description:
    "Changes the name, description, type, scope, location, parent or tags of an actor and returns it. Only the given properties change; " +
    "scope, location and parent_actor accept null to clear the relation. Changing the type does not check the held items, " +
    "the flows and the parent of the actor: the network check reports the ones whose domain no longer fits.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("actor", "Id or name of the actor to update."),
      display_name: localizedTextParam("New display name; each given language replaces the same language, the others are kept."),
      description: localizedTextParam("New Markdown description; same language rule as name."),
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
    const actor = await loadInstance(context, "scflow.actor", params.id);
    const patch: Record<string, unknown> = {};

    if (params.display_name !== undefined) {
      patch.display_name = { set: toLocalized(params.display_name) };
    }
    if (params.description !== undefined) {
      patch.description = { set: toLocalized(params.description) };
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
      if (params.parent_actor === null) {
        patch.parent_actor = null;
      } else {
        const parent = await loadInstance(context, "scflow.actor", params.parent_actor);
        await assertNoCycle(context, actor, parent);
        patch.parent_actor = parent.id;
      }
    }
    const tags = unique(params.tags);
    if (tags !== undefined) {
      patch.tags = tags;
    }

    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.actor",
      filters: { id: actor.id },
      input: patch,
    });
    return summarizeActor(after[0] as unknown as Instance);
  },
};

/** Deletes an actor; see `scflow/delete_actor` in `docs/actions.md`. */
export const deleteActorAction: ScflowActionDefinition<DeleteActorParams, { id: string }> = {
  id: "scflow/delete_actor",
  writes: ["actor", "flow", "item_at_actor", "transformation", "transformation_line", "conversion"],
  destructive: true,
  title: "Delete an actor",
  description:
    "Deletes an actor. It is refused while child actors, flows, held items, transformations or conversions reference the actor, unless cascade is true, " +
    "which deletes the child actors recursively, the flows incident to the actor and its descendants, the items they hold, " +
    "their transformations and conversions and the notes of every deleted entity.",
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
    const actor = await loadInstance(context, "scflow.actor", params.id);
    const cascade = params.cascade === true;
    const snapshot = await loadSnapshot(context);

    if (!cascade) {
      assertUnreferenced(snapshot, actor);
    }
    await deleteActorTrees(context, snapshot, [actor.id]);
    return { id: actor.id };
  },
};

/** Deletes an actor type; see `scflow/delete_actor_type` in `docs/actions.md`. */
export const deleteActorTypeAction: ScflowActionDefinition<DeleteActorTypeParams, { id: string }> = {
  id: "scflow/delete_actor_type",
  writes: ["actor", "flow", "item_at_actor", "transformation", "transformation_line", "conversion", "actor_type"],
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
    const type = await loadInstance(context, "scflow.actor_type", params.id);
    const cascade = params.cascade === true;
    const snapshot = await loadSnapshot(context);
    const actors = snapshot.actors.filter((actor) => actor.type === type.id);

    if (actors.length > 0 && !cascade) {
      throw new Error(
        `parameter "id": "${labelOf(type)}" is used by ${actors.length} actor(s); use cascade: true to delete them`,
      );
    }
    await deleteActorTrees(context, snapshot, actors.map((actor) => actor.id));
    await context.runCommand(context.locator, { kind: "delete", schema: "scflow.actor_type", filters: { id: type.id } });
    return { id: type.id };
  },
};

/** Deletes a scope; see `scflow/delete_scope` in `docs/actions.md`. */
export const deleteScopeAction: ScflowActionDefinition<DeleteScopeParams, { id: string }> = {
  id: "scflow/delete_scope",
  writes: ["actor", "flow", "item_at_actor", "transformation", "transformation_line", "conversion", "scope", "actor_type"],
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
    const scope = await loadInstance(context, "scflow.scope", params.id);
    const cascade = params.cascade === true;
    const snapshot = await loadSnapshot(context);
    const actors = snapshot.actors.filter((actor) => actor.scope === scope.id);

    if (actors.length > 0 && !cascade) {
      throw new Error(
        `parameter "id": "${labelOf(scope)}" is used by ${actors.length} actor(s); use cascade: true to delete them`,
      );
    }
    await deleteActorTrees(context, snapshot, actors.map((actor) => actor.id));
    await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.actor_type",
      filters: { default_scope: scope.id },
      input: { default_scope: null },
    });
    await context.runCommand(context.locator, { kind: "delete", schema: "scflow.scope", filters: { id: scope.id } });
    return { id: scope.id };
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

/**
 * Refuses the deletion of an actor that child actors, flows, held items or transformations reference.
 *
 * @throws An error that counts each kind of reference.
 */
function assertUnreferenced(snapshot: Snapshot, actor: Instance): void {
  const references = [
    [snapshot.actors.filter((other) => other.parent_actor === actor.id).length, "child actor"],
    [snapshot.flows.filter((flow) => flow.source === actor.id || flow.destination === actor.id).length, "flow"],
    [snapshot.held.filter((record) => record.actor === actor.id).length, "held item"],
    [snapshot.transformations.filter((transformation) => transformation.actor === actor.id).length, "transformation"],
    [snapshot.conversions.filter((conversion) => conversion.actor === actor.id).length, "conversion"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${what}(s)`);
  if (references.length > 0) {
    throw new Error(
      `parameter "id": "${labelOf(actor)}" is still referenced by ${references.join(", ")}; use cascade: true to delete them`,
    );
  }
}

/** Deletes actors with their descendants and everything that depends on them. */
async function deleteActorTrees(
  context: ActionAccess,
  snapshot: Snapshot,
  actorIds: readonly string[],
): Promise<void> {
  const set = newDeletionSet();
  addActorTrees(snapshot, set, actorIds);
  closeDeletionSet(snapshot, set);
  await executeDeletion(context, snapshot, set);
}

/**
 * Refuses a parent that is the actor itself or one of its descendants, which
 * would make the actor its own ancestor.
 */
async function assertNoCycle(context: ActionAccess, actor: Instance, parent: Instance): Promise<void> {
  const { after } = await context.runCommand(context.locator, { kind: "query", schema: "scflow.actor" });
  const parentOf = new Map(
    (after as unknown as Instance[]).map((instance) => [instance.id, instance.parent_actor as string | undefined]),
  );
  const seen = new Set<string>();
  for (let current: string | undefined = parent.id; current !== undefined && !seen.has(current); ) {
    if (current === actor.id) {
      throw new Error(
        `parameter "parent_actor": "${labelOf(parent)}" cannot be the parent of "${labelOf(actor)}", it would make the actor its own ancestor`,
      );
    }
    seen.add(current);
    current = parentOf.get(current) ?? undefined;
  }
}

function summarizeActor(actor: Instance): ActorSummary {
  return {
    id: actor.id,
    display_name: actor.display_name as Record<string, string>,
    type: actor.type as string,
    ...(actor.scope ? { scope: actor.scope as string } : {}),
    ...(actor.location ? { location: actor.location as string } : {}),
    ...(actor.parent_actor ? { parent_actor: actor.parent_actor as string } : {}),
  };
}

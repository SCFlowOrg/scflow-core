import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";
import { createActor } from "../actors.js";
import {
  addActorTrees,
  closeDeletionSet,
  executeDeletion,
  loadSnapshot,
  newDeletionSet,
  type Snapshot,
} from "./delete-impact.js";
import {
  localizedTextParam,
  nullableRefParam,
  optionalBoolean,
  optionalDomains,
  optionalStringList,
  refParam,
  tagsParam,
} from "./params.js";
import { labelOf, resolveRef, type Instance } from "./refs.js";
import { toLocalized } from "./text.js";

/** A text parameter: a string, or a map of language to string. */
type Text = string | Record<string, string>;

/** Parameters of `scflow/create_scope`. */
export interface CreateScopeParams {
  name: Text;
  description?: Text;
}

/** Parameters of `scflow/create_actor_type`. */
export interface CreateActorTypeParams {
  name: Text;
  domains?: string[];
  default_scope?: string;
  description?: Text;
}

/** Parameters of `scflow/create_actor`. */
export interface CreateActorParams {
  name: Text;
  type: string;
  scope?: string;
  location?: string;
  parent_actor?: string;
  description?: Text;
  tags?: string[];
}

/** Parameters of `scflow/update_actor`. */
export interface UpdateActorParams {
  actor: string;
  name?: Text;
  description?: Text;
  type?: string;
  scope?: string | null;
  location?: string | null;
  parent_actor?: string | null;
  tags?: string[];
}

/** Parameters of `scflow/delete_actor`. */
export interface DeleteActorParams {
  actor: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_actor_type`. */
export interface DeleteActorTypeParams {
  type: string;
  cascade?: boolean;
}

/** Parameters of `scflow/delete_scope`. */
export interface DeleteScopeParams {
  scope: string;
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
export const createScopeAction: ModelActionDefinition<CreateScopeParams, ScopeSummary> = {
  id: "scflow/create_scope",
  title: "Create a scope",
  description:
    "Creates a scope, a lane that groups actors (for example SOURCE, MAKE, DELIVER or a region), and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Display name of the scope, a string or a map of language to string."),
      description: localizedTextParam("Markdown description of the scope."),
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const input: Record<string, unknown> = { display_name: toLocalized(params.name, "name") };
    if (params.description !== undefined) {
      input.description = toLocalized(params.description, "description");
    }
    const { after } = await access.runCommand(locator, { kind: "create", schema: "scope", input });
    const scope = after[0] as unknown as Instance;
    return { id: scope.id, display_name: scope.display_name as Record<string, string> };
  },
};

/** Creates an actor type; see `scflow/create_actor_type` in `docs/actions.md`. */
export const createActorTypeAction: ModelActionDefinition<CreateActorTypeParams, ActorTypeSummary> = {
  id: "scflow/create_actor_type",
  title: "Create an actor type",
  description:
    "Creates an actor type with the flow domains its actors can exchange, and an optional default scope, and returns it.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Display name of the actor type, a string or a map of language to string."),
      domains: {
        type: "array",
        items: { type: "string", enum: ["physical", "information", "financial", "service"] },
        default: ["physical"],
        description: "Flow domains of the type; physical when omitted.",
      },
      default_scope: refParam("Id or name of the scope given to the actors of this type that name no scope."),
      description: localizedTextParam("Markdown description of the actor type."),
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const display_name = toLocalized(params.name, "name");
    const domains = optionalDomains(params.domains, "domains") ?? ["physical"];
    const input: Record<string, unknown> = { display_name, domains };
    if (params.default_scope !== undefined) {
      input.default_scope = (await resolveRef(access, locator, "scope", params.default_scope, "default_scope")).id;
    }
    if (params.description !== undefined) {
      input.description = toLocalized(params.description, "description");
    }
    const { after } = await access.runCommand(locator, { kind: "create", schema: "actor_type", input });
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
export const createActorAction: ModelActionDefinition<CreateActorParams, ActorSummary> = {
  id: "scflow/create_actor",
  title: "Create an actor",
  description:
    "Creates an actor of a given type in the network, optionally in a scope, at a location and inside a parent actor, and returns it. " +
    "The scope defaults to the default scope of the type; the location has no default.",
  parameters: {
    type: "object",
    properties: {
      name: localizedTextParam("Display name of the actor, a string or a map of language to string."),
      type: refParam("Id or name of the actor type."),
      scope: refParam("Id or name of the containing scope; the default scope of the type when omitted."),
      location: refParam("Id or name of the location of the actor; none when omitted."),
      parent_actor: refParam("Id or name of the parent actor, to nest the actor in a hierarchy."),
      description: localizedTextParam("Markdown description of the actor."),
      tags: tagsParam("Tags of the actor."),
    },
    required: ["name", "type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const display_name = toLocalized(params.name, "name");
    const type = await resolveRef(access, locator, "actor_type", params.type, "type");
    const input: Parameters<typeof createActor>[2] = { display_name, type: type.id };
    if (params.scope !== undefined) {
      input.scope = (await resolveRef(access, locator, "scope", params.scope, "scope")).id;
    }
    if (params.location !== undefined) {
      input.location = (await resolveRef(access, locator, "location", params.location, "location")).id;
    }
    if (params.parent_actor !== undefined) {
      input.parent_actor = (await resolveRef(access, locator, "actor", params.parent_actor, "parent_actor")).id;
    }
    if (params.description !== undefined) {
      input.description = toLocalized(params.description, "description");
    }
    const tags = optionalStringList(params.tags, "tags");
    if (tags !== undefined) {
      input.tags = tags;
    }
    return summarizeActor(await createActor(access, locator, input) as Instance);
  },
};

/** Updates an actor; see `scflow/update_actor` in `docs/actions.md`. */
export const updateActorAction: ModelActionDefinition<UpdateActorParams, ActorSummary> = {
  id: "scflow/update_actor",
  title: "Update an actor",
  description:
    "Changes the name, description, type, scope, location, parent or tags of an actor and returns it. Only the given properties change; " +
    "scope, location and parent_actor accept null to clear the relation. Changing the type does not check the held items, " +
    "the flows and the parent of the actor: the network check reports the ones whose domain no longer fits.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("Id or name of the actor to update."),
      name: localizedTextParam("New display name; each given language replaces the same language, the others are kept."),
      description: localizedTextParam("New Markdown description; same language rule as name."),
      type: refParam("Id or name of the new actor type."),
      scope: nullableRefParam("Id or name of the new scope, or null to detach the actor from its scope."),
      location: nullableRefParam("Id or name of the new location, or null to remove the location of the actor."),
      parent_actor: nullableRefParam("Id or name of the new parent actor, or null to move the actor to the root."),
      tags: tagsParam("New tags; they replace the current ones."),
    },
    required: ["actor"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const actor = await resolveRef(access, locator, "actor", params.actor, "actor");
    const patch: Record<string, unknown> = {};

    if (params.name !== undefined) {
      patch.display_name = { set: toLocalized(params.name, "name") };
    }
    if (params.description !== undefined) {
      patch.description = { set: toLocalized(params.description, "description") };
    }
    if (params.type !== undefined) {
      patch.type = (await resolveRef(access, locator, "actor_type", params.type, "type")).id;
    }
    if (params.scope !== undefined) {
      patch.scope =
        params.scope === null ? null : (await resolveRef(access, locator, "scope", params.scope, "scope")).id;
    }
    if (params.location !== undefined) {
      patch.location =
        params.location === null
          ? null
          : (await resolveRef(access, locator, "location", params.location, "location")).id;
    }
    if (params.parent_actor !== undefined) {
      if (params.parent_actor === null) {
        patch.parent_actor = null;
      } else {
        const parent = await resolveRef(access, locator, "actor", params.parent_actor, "parent_actor");
        await assertNoCycle(access, locator, actor, parent);
        patch.parent_actor = parent.id;
      }
    }
    const tags = optionalStringList(params.tags, "tags");
    if (tags !== undefined) {
      patch.tags = tags;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'scflow/update_actor: give at least one property to change besides "actor" (name, description, type, scope, location, parent_actor, tags)',
      );
    }

    const { after } = await access.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: actor.id },
      input: patch,
    });
    return summarizeActor(after[0] as unknown as Instance);
  },
};

/** Deletes an actor; see `scflow/delete_actor` in `docs/actions.md`. */
export const deleteActorAction: ModelActionDefinition<DeleteActorParams, { id: string }> = {
  id: "scflow/delete_actor",
  title: "Delete an actor",
  description:
    "Deletes an actor. It is refused while child actors, flows, held items, transformations or conversions reference the actor, unless cascade is true, " +
    "which deletes the child actors recursively, the flows incident to the actor and its descendants, the items they hold, " +
    "their transformations and conversions and the notes of every deleted entity.",
  parameters: {
    type: "object",
    properties: {
      actor: refParam("Id or name of the actor to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description:
          "When true, also deletes the descendant actors, the incident flows, the held items, the transformations, the conversions and the notes.",
      },
    },
    required: ["actor"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const actor = await resolveRef(access, locator, "actor", params.actor, "actor");
    const cascade = optionalBoolean(params.cascade, "cascade") ?? false;
    const snapshot = await loadSnapshot(access, locator);

    if (!cascade) {
      assertUnreferenced(snapshot, actor);
    }
    await deleteActorTrees(access, locator, snapshot, [actor.id]);
    return { id: actor.id };
  },
};

/** Deletes an actor type; see `scflow/delete_actor_type` in `docs/actions.md`. */
export const deleteActorTypeAction: ModelActionDefinition<DeleteActorTypeParams, { id: string }> = {
  id: "scflow/delete_actor_type",
  title: "Delete an actor type",
  description:
    "Deletes an actor type. It is refused while actors have this type, unless cascade is true, which deletes those actors " +
    "first, each with the cascade of scflow/delete_actor.",
  parameters: {
    type: "object",
    properties: {
      type: refParam("Id or name of the actor type to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description: "When true, also deletes the actors of this type with their descendants, flows, held items, transformations and notes.",
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const type = await resolveRef(access, locator, "actor_type", params.type, "type");
    const cascade = optionalBoolean(params.cascade, "cascade") ?? false;
    const snapshot = await loadSnapshot(access, locator);
    const actors = snapshot.actors.filter((actor) => actor.type === type.id);

    if (actors.length > 0 && !cascade) {
      throw new Error(
        `parameter "type": "${labelOf(type)}" is used by ${actors.length} actor(s); use cascade: true to delete them`,
      );
    }
    await deleteActorTrees(access, locator, snapshot, actors.map((actor) => actor.id));
    await access.runCommand(locator, { kind: "delete", schema: "actor_type", filters: { id: type.id } });
    return { id: type.id };
  },
};

/** Deletes a scope; see `scflow/delete_scope` in `docs/actions.md`. */
export const deleteScopeAction: ModelActionDefinition<DeleteScopeParams, { id: string }> = {
  id: "scflow/delete_scope",
  title: "Delete a scope",
  description:
    "Deletes a scope. It is refused while actors are assigned to it, unless cascade is true, which deletes those actors first, " +
    "each with the cascade of scflow/delete_actor. The default scope of an actor type that names the scope is cleared.",
  parameters: {
    type: "object",
    properties: {
      scope: refParam("Id or name of the scope to delete."),
      cascade: {
        type: "boolean",
        default: false,
        description: "When true, also deletes the actors of this scope with their descendants, flows, held items, transformations and notes.",
      },
    },
    required: ["scope"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const scope = await resolveRef(access, locator, "scope", params.scope, "scope");
    const cascade = optionalBoolean(params.cascade, "cascade") ?? false;
    const snapshot = await loadSnapshot(access, locator);
    const actors = snapshot.actors.filter((actor) => actor.scope === scope.id);

    if (actors.length > 0 && !cascade) {
      throw new Error(
        `parameter "scope": "${labelOf(scope)}" is used by ${actors.length} actor(s); use cascade: true to delete them`,
      );
    }
    await deleteActorTrees(access, locator, snapshot, actors.map((actor) => actor.id));
    await access.runCommand(locator, {
      kind: "update",
      schema: "actor_type",
      filters: { default_scope: scope.id },
      input: { default_scope: null },
    });
    await access.runCommand(locator, { kind: "delete", schema: "scope", filters: { id: scope.id } });
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
      `parameter "actor": "${labelOf(actor)}" is still referenced by ${references.join(", ")}; use cascade: true to delete them`,
    );
  }
}

/** Deletes actors with their descendants and everything that depends on them. */
async function deleteActorTrees(
  access: MclAccess,
  locator: string,
  snapshot: Snapshot,
  actorIds: readonly string[],
): Promise<void> {
  const set = newDeletionSet();
  addActorTrees(snapshot, set, actorIds);
  closeDeletionSet(snapshot, set);
  await executeDeletion(access, locator, snapshot, set);
}

/**
 * Refuses a parent that is the actor itself or one of its descendants, which
 * would make the actor its own ancestor.
 */
async function assertNoCycle(access: MclAccess, locator: string, actor: Instance, parent: Instance): Promise<void> {
  const { after } = await access.runCommand(locator, { kind: "query", schema: "actor" });
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

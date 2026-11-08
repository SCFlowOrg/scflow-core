import type { MclAccess } from "@scfloworg/core";

/** The properties of an actor to create. */
export interface CreateActorInput {
  /** Display name of the actor, per language. */
  display_name: Record<string, string>;
  /** Id of the `actor_type` of the actor. */
  type: string;
  /** Id of the scope that contains the actor; defaults to the `default_scope` of `type`. */
  scope?: string;
  /** Id of the `location` of the actor; the actor has no location when absent. */
  location?: string;
  /** Description of the actor, per language. */
  description?: Record<string, string>;
  /** Id of the actor that contains the actor; the actor is at the root when absent. */
  parent_actor?: string;
  /** Tags of the actor. */
  tags?: string[];
}

/**
 * Creates an actor and returns it.
 *
 * The actor takes `scope` when the input gives one, which always overrides the
 * default. Otherwise it takes the `default_scope` of its type, and no scope when
 * the type has none. The default is applied at creation: a later change of the
 * `default_scope` of the type leaves the existing actors unchanged.
 *
 * The actor is at the `location` of the input when the input gives one, and at
 * none otherwise: a location has no default.
 *
 * @returns The created actor.
 * @throws When the type, the given scope or the given location does not exist.
 */
export async function createActor(
  mcl: MclAccess,
  locator: string,
  input: CreateActorInput,
): Promise<Record<string, unknown>> {
  const { type, scope, ...rest } = input;

  const types = await mcl.runCommand(locator, {
    kind: "query",
    schema: "scflow.actor_type",
    filters: { id: type },
  });
  if (types.after.length === 0) {
    throw new Error(`createActor: actor type "${type}" does not exist`);
  }
  const defaultScope = (types.after[0] as unknown as { default_scope?: string | null }).default_scope;

  const actorScope = scope ?? defaultScope ?? undefined;
  if (scope !== undefined) {
    await assertScopeExists(mcl, locator, scope);
  }

  const { after } = await mcl.runCommand(locator, {
    kind: "create",
    schema: "scflow.actor",
    input: { ...rest, type, ...(actorScope === undefined ? {} : { scope: actorScope }) },
  });
  return after[0] as unknown as Record<string, unknown>;
}

async function assertScopeExists(mcl: MclAccess, locator: string, scope: string): Promise<void> {
  const scopes = await mcl.runCommand(locator, {
    kind: "query",
    schema: "scflow.scope",
    filters: { id: scope },
  });
  if (scopes.after.length === 0) {
    throw new Error(`createActor: scope "${scope}" does not exist`);
  }
}

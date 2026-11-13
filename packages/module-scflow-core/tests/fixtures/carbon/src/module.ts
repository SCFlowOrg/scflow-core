/// <reference types="@scfloworg/module/yaml" />
// The code of acme:carbon, built to dist/module.js by the acceptance of
// phase B. It imports only types of the engine and of the environment.
import type { TransientObject } from "@scfloworg/core";
import type { ActionContext } from "@scfloworg/environment";
import { defineModule } from "@scfloworg/module";
import manifest from "../module.yaml";

/** The emissions of the actor `id`: its `carbon` facet values, `{}` when none is set. */
async function emissionsOf(context: ActionContext, id: string): Promise<TransientObject> {
  const { after } = await context.runCommand(context.locator, {
    query: "scflow.actor",
    filters: { id },
  });
  const actor = after[0] as TransientObject | undefined;
  if (!actor) throw new Error(`no actor "${id}"`);
  return (actor.carbon as TransientObject | undefined) ?? {};
}

export default defineModule(manifest, {
  actions: {
    async update_actor_emissions(context: ActionContext, params: { id: string; co2: number }) {
      await context.runCommand(context.locator, {
        update: "scflow.actor",
        filters: { id: params.id },
        input: { carbon: { co2: params.co2 } },
      });
      return emissionsOf(context, params.id);
    },
    get_actor_emissions: (context: ActionContext, params: { id: string }) =>
      emissionsOf(context, params.id),
  },
});

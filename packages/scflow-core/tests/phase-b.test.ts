import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { beforeAll, describe, expect, it } from "vitest";
import type { TransientObject } from "@scfloworg/core";
import { createEnvironment } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { buildModule } from "@scfloworg/module/build";

/**
 * The acceptance of phase B of `SCFlowOrg/scflow-core#2`, with no application:
 * a sample module with a facet, `acme:carbon` (a facet on `scflow.actor` with a
 * `co2` property, in `fixtures/carbon`), loads on `scflow:core` in an
 * environment, and a dataset is saved and reloaded with both modules embedded,
 * facet values included.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const carbon = join(root, "tests", "fixtures", "carbon");

/** An environment of its own, with both modules loaded from their folders, bundles included. */
async function environment(...folders: string[]) {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  for (const folder of folders) await env.modules.load(folder);
  return env;
}

describe("phase B", () => {
  beforeAll(async () => {
    await buildModule(root);
    await buildModule(carbon);
  }, 60000);

  it("loads a module with a facet on scflow:core, then saves and reloads a dataset with both modules embedded, facet values included", async () => {
    const env = await environment(root, carbon);
    expect(env.modules.list().map((module) => [module.key, module.actions.size > 0])).toEqual([
      ["scflow:core", true],
      ["acme:carbon", true],
    ]);

    // acme:carbon is named alone: its dependency scflow:core comes with it.
    const dataset = await env.datasets.create({
      locator: "js:lyon",
      name: "lyon",
      modules: ["acme:carbon"],
    });
    expect(dataset.readOnly).toBe(false);
    expect(dataset.modules).toEqual([
      { module: "scflow:core", version: "1.0.0", installed: "1.0.0", state: "current" },
      { module: "acme:carbon", version: "1.0.0", installed: "1.0.0", state: "current" },
    ]);

    // The actor and its type are written below the actions: the actions of
    // scflow:core still name its schemas by short names, which a dataset of
    // modules does not resolve, and generated actions come with phase C. The
    // engine does not refuse a write outside an action before piece 1.8.
    const { after: types } = await dataset.query({
      create: "scflow.actor_type",
      input: { display_name: { en: "Plant" }, domains: ["physical"] },
    });
    const { after: actors } = await dataset.query({
      create: "scflow.actor",
      input: { display_name: { en: "Lyon" }, type: (types[0] as TransientObject).id },
    });
    const actor = String((actors[0] as TransientObject).id);
    expect(actors[0]).not.toHaveProperty("carbon");

    // The facet value is written by an action of its own module, in one transaction.
    const outcome = await dataset.run("carbon/update_actor_emissions", { id: actor, co2: 12 });
    expect(outcome).toMatchObject({ result: { co2: 12 }, changed: true });
    expect(outcome.delta).not.toBeNull();

    // Saved: both modules embedded, the facet values under the facet.
    const dump = await dataset.dump("yaml");
    const saved = load(dump) as Record<string, TransientObject>;
    expect(Object.keys(saved.modules)).toEqual(["scflow:core", "acme:carbon"]);
    expect(saved.modules["acme:carbon"]).toEqual({
      version: "1.0.0",
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(saved.model["scflow:core"]).toMatchObject({ name: "scflow:core", namespace: "scflow" });
    expect(saved.model["acme:carbon"]).toMatchObject({
      name: "acme:carbon",
      schemas: [{ name: "actor_emissions", facet_of: "scflow.actor" }],
    });
    expect(Object.values(saved.data["carbon.actor_emissions"] as TransientObject)).toMatchObject([
      { co2: 12 },
    ]);

    // Reloaded in another environment, which shares nothing with the first.
    const other = await environment(root, carbon);
    const reloaded = await other.datasets.restore("js:lyon", dump, "yaml");
    expect(reloaded.readOnly).toBe(false);
    expect(reloaded.modules.map((module) => module.state)).toEqual(["current", "current"]);
    expect((await reloaded.run("carbon/get_actor_emissions", { id: actor })).result).toEqual({
      co2: 12,
    });
    const { after } = await reloaded.query({ query: "scflow.actor" });
    expect(after).toMatchObject([{ id: actor, display_name: { en: "Lyon" }, carbon: { co2: 12 } }]);
    expect(load(await reloaded.dump("yaml"))).toEqual(saved);

    // The facet values stay writable after the reload.
    await reloaded.run("carbon/update_actor_emissions", { id: actor, co2: 7 });
    expect((await reloaded.run("carbon/get_actor_emissions", { id: actor })).result).toEqual({
      co2: 7,
    });
  });

  it("reloads the dataset read only where acme:carbon is not installed, its facet values kept", async () => {
    const env = await environment(root, carbon);
    const dataset = await env.datasets.create({ locator: "js:lyon", modules: ["acme:carbon"] });
    const { after: types } = await dataset.query({
      create: "scflow.actor_type",
      input: { display_name: { en: "Plant" }, domains: ["physical"] },
    });
    const { after: actors } = await dataset.query({
      create: "scflow.actor",
      input: { display_name: { en: "Lyon" }, type: (types[0] as TransientObject).id },
    });
    const actor = String((actors[0] as TransientObject).id);
    await dataset.run("carbon/update_actor_emissions", { id: actor, co2: 12 });

    const reloaded = await (
      await environment(root)
    ).datasets.restore("js:lyon", await dataset.dump("json"), "json");
    expect(reloaded.readOnly).toBe(true);
    expect(reloaded.modules.map((module) => [module.module, module.state])).toEqual([
      ["scflow:core", "current"],
      ["acme:carbon", "missing"],
    ]);
    const { after } = await reloaded.query({ query: "scflow.actor" });
    expect(after).toMatchObject([{ id: actor, carbon: { co2: 12 } }]);
    await expect(
      reloaded.run("carbon/update_actor_emissions", { id: actor, co2: 1 }),
    ).rejects.toMatchObject({
      code: "unknown_action",
    });
  });
});

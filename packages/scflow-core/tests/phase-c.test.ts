import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { beforeAll, describe, expect, it } from "vitest";
import type { TransientObject } from "@scfloworg/core";
import { createEnvironment } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";
import { buildModule } from "@scfloworg/module/build";
import { ACTION_BODIES } from "../src/actions/index.js";

/**
 * The acceptance of phase C of `SCFlowOrg/scflow-core#3`, with no application:
 * `scflow:core` works through actions, a broken rule is refused at prepare, and
 * a dataset upgrades through a migration.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type Manifest = Record<string, any>;

const current = (): Manifest => load(readFileSync(join(root, "module.yaml"), "utf8")) as Manifest;

/** An environment holding one version of the module, with the action bodies of the package. */
function environmentWith(manifest: Manifest) {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  env.modules.install(defineModule(manifest as never, { actions: ACTION_BODIES }));
  return env;
}

/** The manifest of a next version of the module, which renames `timezone` of a location through a declared migration. */
function nextVersion(): Manifest {
  const manifest = current();
  const location = manifest.schemas.find((schema: Manifest) => schema.name === "location");
  location.properties.find((property: Manifest) => property.name === "timezone").name = "time_zone";
  return {
    ...manifest,
    version: "2.0.0",
    migrations: [{ to: "2.0.0", rename_property: { schema: "location", from: "timezone", to: "time_zone" } }],
  };
}

/** The manifest of the version before the rules were declared. */
function withoutRules(): Manifest {
  const manifest = current();
  for (const schema of manifest.schemas as Manifest[]) {
    delete schema.checks;
    delete schema.unique;
  }
  return { ...manifest, version: "1.0.0" };
}

describe("phase C", () => {
  beforeAll(async () => {
    await buildModule(root);
  }, 60000);

  it("works through the actions of scflow:core, loaded from its bundle", async () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    await env.modules.load(root);
    const dataset = await env.datasets.create({ locator: "js:acceptance", modules: ["scflow:core"] });

    await dataset.run("scflow/create_scope", { display_name: "Make" });
    await dataset.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"], default_scope: "Make" });
    await dataset.run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
    await dataset.run("scflow/create_transformation_type", { display_name: "Assembly" });
    const plant = await dataset.run("scflow/create_actor", { display_name: "Plant", type: "Site" });
    await dataset.run("scflow/create_actor", { display_name: "Depot", type: "Site" });
    await dataset.run("scflow/create_item", { display_name: "Bolt", type: "Part" });
    await dataset.run("scflow/create_item", { display_name: "Frame", type: "Part" });
    const flow = await dataset.run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    const process = await dataset.run("scflow/define_process", {
      actor: "Plant",
      transformation_type: "Assembly",
      consumed_items: ["Bolt"],
      produced_items: ["Frame"],
    });

    expect(plant.result).toMatchObject({ scope: expect.any(String) });
    expect(flow).toMatchObject({ changed: true });
    expect(process.result).toMatchObject({ transformation: { display_name: { en: "Assembly" } }, lines: [{ role: "consumed" }, { role: "produced" }] });
    expect((await dataset.query({ query: "scflow.item_at_actor" })).after).toHaveLength(3);
  });

  it("refuses a broken rule at prepare, and the whole action changes nothing", async () => {
    const env = environmentWith(current());
    const dataset = await env.datasets.create({ locator: "js:refused", modules: ["scflow:core"] });
    await dataset.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
    await dataset.run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
    await dataset.run("scflow/create_item_type", { display_name: "Money", domain: "financial" });
    await dataset.run("scflow/create_actor", { display_name: "Plant", type: "Site" });
    await dataset.run("scflow/create_actor", { display_name: "Depot", type: "Site" });
    await dataset.run("scflow/create_item", { display_name: "Euro", type: "Money" });

    // The body writes the holdings and the flow: the breach is found only when the transaction prepares.
    await expect(
      dataset.run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Euro" }),
    ).rejects.toMatchObject({ code: "rule_violation", details: { schema: "scflow.flow" } });
    expect((await dataset.query({ query: "scflow.flow" })).after).toHaveLength(0);
    expect((await dataset.query({ query: "scflow.item_at_actor" })).after).toHaveLength(0);
  });

  it("upgrades a dataset through a migration when it is opened", async () => {
    const env = environmentWith(current());
    const dataset = await env.datasets.create({ locator: "js:upgraded", modules: ["scflow:core"] });
    await dataset.run("scflow/create_location", { display_name: { en: "Lyon" }, timezone: "Europe/Paris" });
    const dump = await dataset.dump("json");

    const reopened = await environmentWith(nextVersion()).datasets.restore("js:upgraded", dump, "json");

    expect(reopened.upgrades).toMatchObject([{ module: "scflow:core", to: "2.0.0" }]);
    expect(reopened.modules).toMatchObject([{ module: "scflow:core", version: "2.0.0", state: "current" }]);
    const [location] = (await reopened.query({ query: "scflow.location" })).after as TransientObject[];
    expect(location).toMatchObject({ time_zone: "Europe/Paris" });
    expect(location).not.toHaveProperty("timezone");
  });

  it("upgrades a valid dataset to the version with the rules, actors without a scope included", async () => {
    const env = environmentWith(withoutRules());
    const dataset = await env.datasets.create({ locator: "js:valid", modules: ["scflow:core"] });
    await dataset.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
    await dataset.run("scflow/create_actor", { display_name: "Plant", type: "Site" });

    const reopened = await environmentWith(current()).datasets.restore("js:valid", await dataset.dump("json"), "json");

    expect(reopened.modules).toMatchObject([{ module: "scflow:core", state: "current" }]);
    expect((await reopened.query({ query: "scflow.actor" })).after).toHaveLength(1);
  });

  it("refuses the upgrade of a dataset that breaks a rule, and lists the instance at fault", async () => {
    const env = environmentWith(withoutRules());
    const dataset = await env.datasets.create({ locator: "js:broken", modules: ["scflow:core"] });
    await dataset.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
    await dataset.run("scflow/create_actor", { display_name: "Plant", type: "Site" });
    await dataset.run("scflow/create_actor", { display_name: "Line", type: "Site", parent_actor: "Plant" });
    const flow = await dataset.run("scflow/create_flow", { source: "Line", destination: "Plant" });
    const id = (flow.result as TransientObject).id;

    await expect(
      environmentWith(current()).datasets.restore("js:broken", await dataset.dump("json"), "json"),
    ).rejects.toMatchObject({
      code: "rule_violation",
      details: { violations: [{ rule: "internal_flow_item", schema: "scflow.flow", key: id }] },
    });
  });
});

import { describe, expect, it } from "vitest";
import { setupActions } from "./actions-helpers.js";

/**
 * The network rules of `docs/spec/implementation.md`, Network Rules, declared
 * on the schemas: each is refused by the engine, whichever write breaks it.
 */

const refusedBy = (rule: string) => ({ code: "rule_violation", details: { rule } });

/** A dataset with a physical and a financial actor type, a physical and a financial item. */
async function world() {
  const setup = await setupActions();
  const { run } = setup;
  await run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
  await run("scflow/create_actor_type", { display_name: "Bank", domains: ["financial"] });
  await run("scflow/create_actor_type", { display_name: "Hub", domains: ["physical", "financial"] });
  await run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
  await run("scflow/create_item_type", { display_name: "Money", domain: "financial" });
  await run("scflow/create_transformation_type", { display_name: "Assembly" });
  const plant = await run("scflow/create_actor", { display_name: "Plant", type: "Site" });
  const depot = await run("scflow/create_actor", { display_name: "Depot", type: "Site" });
  const bolt = await run("scflow/create_item", { display_name: "Bolt", type: "Part" });
  const euro = await run("scflow/create_item", { display_name: "Euro", type: "Money" });
  return { ...setup, plant, depot, bolt, euro };
}

describe("the rules on domains", () => {
  it("refuses a held item outside the domains of the actor", async () => {
    const { run, query } = await world();
    await expect(run("scflow/hold_item", { actor: "Plant", item: "Euro" })).rejects.toMatchObject(refusedBy("held_item_domain"));
    expect(await query("item_at_actor")).toHaveLength(0);
  });

  it("refuses an item on a flow outside the domains of an end, and writes no holding", async () => {
    const { run, query } = await world();
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Euro" })).rejects.toMatchObject({ code: "rule_violation" });
    expect(await query("flow")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);
  });

  it("refuses a change of the type of an actor when a held item no longer fits", async () => {
    const { run, query, plant } = await world();
    await run("scflow/hold_item", { actor: "Plant", item: "Bolt" });
    await expect(run("scflow/update_actor", { id: "Plant", type: "Bank" })).rejects.toMatchObject(refusedBy("held_item_domain"));
    expect((await query("actor", { id: plant.id }))[0].type).toBe(plant.type);
  });

  it("refuses a change of the type of an item when a flow that carries it no longer fits", async () => {
    const { run, query, bolt } = await world();
    await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    await expect(run("scflow/update_item", { id: "Bolt", type: "Money" })).rejects.toMatchObject({ code: "rule_violation" });
    expect((await query("item", { id: bolt.id }))[0].type).toBe(bolt.type);
  });

  it("re-evaluates a rule when the domain of a type it reads changes", async () => {
    const { run } = await world();
    await run("scflow/hold_item", { actor: "Plant", item: "Bolt" });
    await expect(run("scflow/update_item_type", { id: "Part", domain: "financial" })).rejects.toMatchObject({ code: "rule_violation" });
  });

  it("refuses a child actor with a domain its parent does not have", async () => {
    const { run } = await world();
    await expect(run("scflow/create_actor", { display_name: "Till", type: "Hub", parent_actor: "Plant" })).rejects.toMatchObject(refusedBy("parent_actor_domains"));
    await expect(run("scflow/create_actor", { display_name: "Till", type: "Site", parent_actor: "Plant" })).resolves.toMatchObject({ display_name: { en: "Till" } });
  });

  it("refuses a conversion between two domains", async () => {
    const { run, query } = await world();
    await expect(run("scflow/create_conversion", { actor: "Plant", from_item: "Bolt", to_item: "Euro" })).rejects.toMatchObject(refusedBy("conversion_item_domain"));
    expect(await query("conversion")).toHaveLength(0);
  });
});

describe("the rules on flows", () => {
  it("makes both ends hold the item of a flow", async () => {
    const { run, query } = await world();
    await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    expect(await query("item_at_actor")).toHaveLength(2);
  });

  it("refuses to release an item that a flow of the actor carries", async () => {
    const { run, query } = await world();
    await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    const [held] = await query("item_at_actor");
    await expect(run("scflow/release_held_item", { id: held.id })).rejects.toMatchObject(refusedBy("flow_ends_hold_item"));
    expect(await query("item_at_actor")).toHaveLength(2);
  });

  it("refuses a flow between an actor and its child without an item, whichever write makes it one", async () => {
    const { run, query } = await world();
    await run("scflow/create_actor", { display_name: "Line", type: "Site", parent_actor: "Plant" });
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Line" })).rejects.toMatchObject(refusedBy("internal_flow_item"));
    expect(await query("flow")).toHaveLength(0);

    await run("scflow/create_flow", { source: "Depot", destination: "Line" });
    await expect(run("scflow/update_actor", { id: "Line", parent_actor: "Depot" })).rejects.toMatchObject(refusedBy("internal_flow_item"));
  });

  it("sets the item of a flow once", async () => {
    const { run } = await world();
    await run("scflow/create_item", { display_name: "Nut", type: "Part" });
    const flow = await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    await expect(run("scflow/set_flow_item", { id: flow.id, item: "Nut" })).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(run("scflow/set_flow_item", { id: flow.id, item: "Bolt" })).resolves.toMatchObject({ item: flow.item });
  });
});

describe("the rules on the structure", () => {
  it("refuses a cycle of parents, named after the relation", async () => {
    const { run } = await world();
    await run("scflow/update_actor", { id: "Depot", parent_actor: "Plant" });
    await expect(run("scflow/update_actor", { id: "Plant", parent_actor: "Depot" })).rejects.toMatchObject(refusedBy("parent_actor"));
    await expect(run("scflow/update_actor", { id: "Plant", parent_actor: "Plant" })).rejects.toMatchObject(refusedBy("parent_actor"));
  });

  it("refuses a second record of a held item, written below the actions", async () => {
    const { run, create, plant, bolt } = await world();
    await run("scflow/hold_item", { actor: "Plant", item: "Bolt" });
    await expect(create("item_at_actor", { actor: plant.id, item: bolt.id })).rejects.toMatchObject(refusedBy("held_item_unique"));
  });

  it("refuses a second line of a transformation for the same held item and role, and accepts another role", async () => {
    const { run, create } = await world();
    const held = await run("scflow/hold_item", { actor: "Plant", item: "Bolt" });
    const transformation = await run("scflow/create_transformation", { actor: "Plant", type: "Assembly" });
    await run("scflow/connect_transformation_line", { transformation: transformation.id, held_item: held.id, role: "consumed" });
    await expect(create("transformation_line", { transformation: transformation.id, held_item: held.id, role: "consumed" })).rejects.toMatchObject(refusedBy("transformation_line_unique"));
    await expect(run("scflow/connect_transformation_line", { transformation: transformation.id, held_item: held.id, role: "produced" })).resolves.toMatchObject({ role: "produced" });
  });

  it("refuses a line on an item held by another actor", async () => {
    const { run } = await world();
    const held = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });
    const transformation = await run("scflow/create_transformation", { actor: "Plant", type: "Assembly" });
    await expect(run("scflow/connect_transformation_line", { transformation: transformation.id, held_item: held.id, role: "consumed" })).rejects.toMatchObject(refusedBy("transformation_line_actor"));
  });
});

describe("the defaults declared on the schemas", () => {
  it("gives an actor the default scope of its type, below the actions too", async () => {
    const { run, create, query } = await setupActions();
    const scope = await run("scflow/create_scope", { display_name: "Make" });
    const type = await run("scflow/create_actor_type", { display_name: "Site", default_scope: "Make" });
    const id = await create("actor", { display_name: { en: "Plant" }, type: type.id });
    expect((await query("actor", { id }))[0].scope).toBe(scope.id);
  });

  it("leaves an actor without a scope when its type has none", async () => {
    const { run, query } = await setupActions();
    await run("scflow/create_actor_type", { display_name: "Site" });
    const actor = await run("scflow/create_actor", { display_name: "Plant", type: "Site" });
    expect((await query("actor", { id: actor.id }))[0].scope ?? null).toBeNull();
  });

  it("names a transformation after its type, below the actions too", async () => {
    const { create, query } = await world();
    const type = (await query("transformation_type"))[0];
    const id = await create("transformation", { actor: (await query("actor"))[0].id, type: type.id });
    expect((await query("transformation", { id }))[0].display_name).toEqual({ en: "Assembly" });
  });
});

describe("the delete of a referenced instance", () => {
  it("asks for consent, and removes what depends on it with cascade", async () => {
    const { run, query } = await world();
    await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    await expect(run("scflow/delete_actor", { id: "Plant" })).rejects.toMatchObject({ code: "constraint_violation" });
    expect(await query("flow")).toHaveLength(1);

    await run("scflow/delete_actor", { id: "Plant", cascade: true });
    expect(await query("flow")).toHaveLength(0);
    expect((await query("item_at_actor")).map((record) => record.actor)).toHaveLength(1);
  });

  it("clears the default scope of a type when the scope is deleted", async () => {
    const { run, query } = await setupActions();
    await run("scflow/create_scope", { display_name: "Make" });
    await run("scflow/create_actor_type", { display_name: "Site", default_scope: "Make" });
    await run("scflow/delete_scope", { id: "Make" });
    expect((await query("actor_type"))[0].default_scope ?? null).toBeNull();
  });
});

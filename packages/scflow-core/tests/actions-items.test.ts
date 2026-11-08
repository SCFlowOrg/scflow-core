import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

/**
 * A network with a physical and information site "Depot", a financial actor "Bank",
 * a physical item type "Part" with its item "Bolt", and a financial item "Euro".
 */
async function world() {
  const ctx = await setup();
  const { run } = ctx;
  await run("scflow/create_actor_type", { display_name: "Site", domains: ["physical", "information"] });
  await run("scflow/create_actor_type", { display_name: "Finance", domains: ["financial"] });
  const depot = await run("scflow/create_actor", { display_name: "Depot", type: "Site" });
  const annex = await run("scflow/create_actor", { display_name: "Annex", type: "Site" });
  const bank = await run("scflow/create_actor", { display_name: "Bank", type: "Finance" });
  await run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
  await run("scflow/create_item_type", { display_name: "Money", domain: "financial" });
  const bolt = await run("scflow/create_item", { display_name: "Bolt", type: "Part" });
  const euro = await run("scflow/create_item", { display_name: "Euro", type: "Money" });
  return { ...ctx, depot, annex, bank, bolt, euro };
}

describe("item actions", () => {
  it("are declared with scoped unique ids", () => {
    const ids = ACTIONS.map((action) => action.id);

    for (const id of [
      "scflow/create_item_type",
      "scflow/create_item",
      "scflow/hold_item",
      "scflow/release_held_item",
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain("scflow/assign_item_to_flow");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scflow/create_item_type", () => {
  it("creates an item type with its domain and returns it", async () => {
    const { run, query } = await setup();

    const type = await run("scflow/create_item_type", {
      display_name: { en: "Pallet", fr: "Palette" },
      domain: "physical",
      description: "A wooden pallet",
    });

    expect(type).toMatchObject({ display_name: { en: "Pallet", fr: "Palette" }, domain: "physical" });
    const stored = await query("item_type");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: type.id, description: { en: "A wooden pallet" } });
  });

  it("refuses an unknown or missing domain and writes nothing", async () => {
    const { run, query } = await setup();

    await expect(run("scflow/create_item_type", { display_name: "Odd", domain: "magic" })).rejects.toThrow(/domain/);
    await expect(run("scflow/create_item_type", { display_name: "Odd" })).rejects.toThrow(/domain/);

    expect(await query("item_type")).toHaveLength(0);
  });

  it("refuses a missing name", async () => {
    const { run } = await setup();

    await expect(run("scflow/create_item_type", { domain: "physical" })).rejects.toThrow(/name/);
  });
});

describe("scflow/create_item", () => {
  it("creates an item whose type is given by name, with tags", async () => {
    const { run, query } = await setup();
    const type = await run("scflow/create_item_type", { display_name: "Part", domain: "physical" });

    const item = await run("scflow/create_item", { display_name: "Bolt", type: "Part", tags: ["small", "steel"] });

    expect(item).toMatchObject({ display_name: { en: "Bolt" }, type: type.id });
    expect((await query("item", { id: item.id }))[0].tags).toEqual(["small", "steel"]);
  });

  it("accepts the id of the type", async () => {
    const { run } = await setup();
    const type = await run("scflow/create_item_type", { display_name: "Part", domain: "physical" });

    const item = await run("scflow/create_item", { display_name: "Bolt", type: type.id });

    expect(item.type).toBe(type.id);
  });

  it("refuses an unknown type and writes nothing", async () => {
    const { run, query } = await setup();

    await expect(run("scflow/create_item", { display_name: "Bolt", type: "Ghost" })).rejects.toThrow(/names no instance/);

    expect(await query("item")).toHaveLength(0);
  });

  it("refuses a missing name or type", async () => {
    const { run } = await setup();

    await expect(run("scflow/create_item", { type: "Part" })).rejects.toThrow(/name/);
    await expect(run("scflow/create_item", { display_name: "Bolt" })).rejects.toThrow(/type/);
  });
});

describe("scflow/update_item", () => {
  it("is declared in the catalog", () => {
    expect(ACTIONS.map((action) => action.id)).toContain("scflow/update_item");
  });

  it("renames an item given by name and keeps the other languages", async () => {
    const { run, query, bolt } = await world();
    await run("scflow/update_item", { id: "Bolt", display_name: { fr: "Boulon" } });

    const updated = await run("scflow/update_item", { id: "Bolt", display_name: "Screw" });

    expect(updated.display_name).toEqual({ en: "Screw", fr: "Boulon" });
    expect((await query("item", { id: bolt.id }))[0].display_name).toEqual({ en: "Screw", fr: "Boulon" });
  });

  it("changes the description", async () => {
    const { run, query, bolt } = await world();

    await run("scflow/update_item", { id: bolt.id, description: "Steel bolt" });

    expect((await query("item", { id: bolt.id }))[0].description).toEqual({ en: "Steel bolt" });
  });

  it("changes the type of an item given by name, and refuses an unknown type", async () => {
    const { run, query, bolt } = await world();
    await run("scflow/create_item_type", { display_name: "Tool", domain: "physical" });

    const updated = await run("scflow/update_item", { id: "Bolt", type: "Tool" });

    const stored = (await query("item", { id: bolt.id }))[0];
    expect(updated.type).toBe(stored.type);
    expect(stored.type).not.toBe(bolt.type);
    await expect(run("scflow/update_item", { id: "Bolt", type: "Ghost" })).rejects.toThrow(/names no instance/);
  });

  it("refuses a change of type that a held record of the item no longer fits", async () => {
    const { run, query, bolt } = await world();
    await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });

    await expect(run("scflow/update_item", { id: "Bolt", type: "Money" })).rejects.toMatchObject({ code: "rule_violation", details: { rule: "held_item_domain" } });

    expect(await query("item_at_actor")).toHaveLength(1);
    expect((await query("item", { id: bolt.id }))[0].type).toBe(bolt.type);
  });

  it("refuses a call that gives no property to change, and an unknown or missing item", async () => {
    const { run } = await world();

    await expect(run("scflow/update_item", { id: "Bolt" })).rejects.toThrow(/must NOT have fewer/);
    await expect(run("scflow/update_item", { id: "Ghost", display_name: "X" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/update_item", { display_name: "X" })).rejects.toThrow(/item/);
  });
});

describe("scflow/hold_item", () => {
  it("makes an actor hold an item, both given by name", async () => {
    const { run, query, depot, bolt } = await world();

    const held = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });

    expect(held).toMatchObject({ actor: depot.id, item: bolt.id });
    expect(typeof held.id).toBe("string");
    expect(await query("item_at_actor")).toHaveLength(1);
  });

  it("returns the existing record when the actor already holds the item", async () => {
    const { run, query } = await world();
    const first = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });

    const second = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });

    expect(second.id).toBe(first.id);
    expect(await query("item_at_actor")).toHaveLength(1);
  });

  it("lets two actors hold the same item", async () => {
    const { run, query } = await world();

    await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });
    await run("scflow/hold_item", { actor: "Annex", item: "Bolt" });

    expect(await query("item_at_actor")).toHaveLength(2);
  });

  it("refuses an item whose domain is not among the domains of the actor, and writes nothing", async () => {
    const { run, query } = await world();

    await expect(run("scflow/hold_item", { actor: "Depot", item: "Euro" })).rejects.toMatchObject({ code: "rule_violation", details: { rule: "held_item_domain" } });
    await expect(run("scflow/hold_item", { actor: "Bank", item: "Bolt" })).rejects.toMatchObject({ code: "rule_violation", details: { rule: "held_item_domain" } });

    expect(await query("item_at_actor")).toHaveLength(0);
  });

  it("refuses an unknown actor or item, naming the parameter", async () => {
    const { run } = await world();

    await expect(run("scflow/hold_item", { actor: "Ghost", item: "Bolt" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/hold_item", { actor: "Depot", item: "Ghost" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/hold_item", { item: "Bolt" })).rejects.toThrow(/actor/);
  });
});

describe("scflow/release_held_item", () => {
  it("removes the record and keeps the actor and the item", async () => {
    const { run, query, depot, bolt } = await world();
    const held = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });

    const result = await run("scflow/release_held_item", { id: held.id });

    expect(result).toEqual({ id: held.id });
    expect(await query("item_at_actor")).toHaveLength(0);
    expect(await query("actor", { id: depot.id })).toHaveLength(1);
    expect(await query("item", { id: bolt.id })).toHaveLength(1);
  });

  it("refuses while a transformation line uses the record, and removes nothing", async () => {
    const { run, query, create, depot } = await world();
    const held = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });
    const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
    const transformation = await create("transformation", {
      display_name: { en: "Assemble" },
      type: transformationType,
      actor: depot.id,
    });
    await create("transformation_line", { transformation, role: "consumed", held_item: held.id });

    await expect(run("scflow/release_held_item", { id: held.id })).rejects.toMatchObject({ code: "constraint_violation" });

    expect(await query("item_at_actor")).toHaveLength(1);
    expect(await query("transformation_line")).toHaveLength(1);
  });

  it("deletes the transformation lines that use the record with cascade", async () => {
    const { run, query, create, depot, bolt } = await world();
    const held = await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });
    const type = await create("transformation_type", { display_name: { en: "Assembly" } });
    const transformation = await create("transformation", { display_name: { en: "Assemble" }, type, actor: depot.id });
    await create("transformation_line", { transformation, held_item: held.id, role: "consumed" });

    await expect(run("scflow/release_held_item", { id: held.id })).rejects.toMatchObject({ code: "constraint_violation" });
    await run("scflow/release_held_item", { id: held.id, cascade: true });

    expect(await query("transformation_line")).toHaveLength(0);
    expect(await query("item_at_actor", { item: bolt })).toHaveLength(0);
  });

  it("refuses an unknown or missing record", async () => {
    const { run } = await world();

    await expect(run("scflow/release_held_item", { id: "missing" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/release_held_item", {})).rejects.toThrow(/'id'/);
  });
});

describe("scflow/set_flow_item", () => {
  async function withFlows() {
    const ctx = await world();
    // `physical` links two sites, which share the physical and information domains; `toBank` links a site to the financial Bank.
    const physical = await ctx.run<Record<string, any>>("scflow/create_flow", { source: "Depot", destination: "Annex" });
    const toBank = await ctx.run<Record<string, any>>("scflow/create_flow", { source: "Depot", destination: "Bank" });
    return { ...ctx, physical, toBank };
  }

  it("sets the item of a flow, given by name, and returns the flow", async () => {
    const { run, query, physical, bolt } = await withFlows();

    const flow = await run("scflow/set_flow_item", { id: physical.id, item: "Bolt" });

    expect(flow).toMatchObject({ id: physical.id, item: bolt.id });
    expect((await query("flow", { id: physical.id }))[0].item).toBe(bolt.id);
  });

  it("makes the source and the destination hold the item, keeping the records that exist", async () => {
    const { run, query, physical, depot, annex, bolt } = await withFlows();
    await run("scflow/hold_item", { actor: "Depot", item: "Bolt" });

    await run("scflow/set_flow_item", { id: physical.id, item: "Bolt" });

    const held = (await query("item_at_actor")).map((record) => `${record.actor}/${record.item}`).sort();
    expect(held).toEqual([`${annex.id}/${bolt.id}`, `${depot.id}/${bolt.id}`].sort());
  });

  it("changes nothing when the flow already carries the item", async () => {
    const { run, query, physical } = await withFlows();
    await run("scflow/set_flow_item", { id: physical.id, item: "Bolt" });

    const again = await run("scflow/set_flow_item", { id: physical.id, item: "Bolt" });

    expect(again).toMatchObject({ id: physical.id });
    expect(await query("item_at_actor")).toHaveLength(2);
  });

  it("refuses to change the item of a flow that carries another one", async () => {
    const { run, query, create, physical, bolt } = await withFlows();
    await run("scflow/set_flow_item", { id: physical.id, item: "Bolt" });
    const type = await create("item_type", { display_name: { en: "Tool" }, domain: "physical" });
    await create("item", { display_name: { en: "Drill" }, type });

    await expect(run("scflow/set_flow_item", { id: physical.id, item: "Drill" })).rejects.toMatchObject({ code: "constraint_violation" });

    expect((await query("flow", { id: physical.id }))[0].item).toBe(bolt.id);
  });

  it("refuses an item whose domain is not among the domains of the source or of the destination, and writes nothing", async () => {
    const { run, query, physical, toBank } = await withFlows();

    await expect(run("scflow/set_flow_item", { id: physical.id, item: "Euro" })).rejects.toMatchObject({ code: "rule_violation" });
    await expect(run("scflow/set_flow_item", { id: toBank.id, item: "Euro" })).rejects.toMatchObject({ code: "rule_violation" });
    await expect(run("scflow/set_flow_item", { id: toBank.id, item: "Bolt" })).rejects.toMatchObject({ code: "rule_violation" });

    expect((await query("flow", { id: toBank.id }))[0].item ?? null).toBeNull();
    expect(await query("item_at_actor")).toHaveLength(0);
  });

  it("refuses an unknown flow or item, naming the parameter", async () => {
    const { run, physical } = await withFlows();

    await expect(run("scflow/set_flow_item", { id: "missing", item: "Bolt" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/set_flow_item", { id: physical.id, item: "Ghost" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/set_flow_item", { item: "Bolt" })).rejects.toThrow(/flow/);
  });
});

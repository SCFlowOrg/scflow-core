import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

/**
 * A network with an actor "Depot", the physical items "Bolt" and "Nut",
 * the information item "Order" and the financial item "Euro".
 */
async function world() {
  const ctx = await setup();
  const { run } = ctx;
  await run("scflow/create_actor_type", { display_name: "Site", domains: ["physical", "information"] });
  const depot = await run("scflow/create_actor", { display_name: "Depot", type: "Site" });
  await run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
  await run("scflow/create_item_type", { display_name: "Document", domain: "information" });
  await run("scflow/create_item_type", { display_name: "Money", domain: "financial" });
  const bolt = await run("scflow/create_item", { display_name: "Bolt", type: "Part" });
  const nut = await run("scflow/create_item", { display_name: "Nut", type: "Part" });
  const order = await run("scflow/create_item", { display_name: "Order", type: "Document" });
  const euro = await run("scflow/create_item", { display_name: "Euro", type: "Money" });
  return { ...ctx, depot, bolt, nut, order, euro };
}

describe("conversion actions", () => {
  it("are declared with scoped unique ids", () => {
    const ids = ACTIONS.map((action) => action.id);

    for (const id of ["scflow/create_conversion", "scflow/update_conversion", "scflow/delete_conversion"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scflow/create_conversion", () => {
  it("creates a conversion owned by an actor, between two items given by name", async () => {
    const { run, query, depot, bolt, nut } = await world();

    const conversion = await run("scflow/create_conversion", {
      actor: "Depot",
      from_item: "Bolt",
      to_item: "Nut",
      display_name: { en: "Machining", fr: "Usinage" },
      description: "Turns bolts into nuts",
    });

    expect(conversion).toMatchObject({
      actor: depot.id,
      from_item: bolt.id,
      to_item: nut.id,
      display_name: { en: "Machining", fr: "Usinage" },
    });
    const stored = await query("conversion");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: conversion.id, description: { en: "Turns bolts into nuts" } });
  });

  it("creates a conversion without name or description", async () => {
    const { run, query, depot, bolt, nut } = await world();

    const conversion = await run("scflow/create_conversion", { actor: depot.id, from_item: bolt.id, to_item: nut.id });

    expect(conversion.display_name).toBeUndefined();
    expect(await query("conversion")).toHaveLength(1);
  });

  it("accepts the same item at both ends", async () => {
    const { run, depot, bolt } = await world();

    const conversion = await run("scflow/create_conversion", { actor: depot.id, from_item: bolt.id, to_item: bolt.id });

    expect(conversion).toMatchObject({ from_item: bolt.id, to_item: bolt.id });
  });

  it("refuses two items of different domains and writes nothing", async () => {
    const { run, query } = await world();

    await expect(
      run("scflow/create_conversion", { actor: "Depot", from_item: "Bolt", to_item: "Order" }),
    ).rejects.toThrow(/domain/);

    expect(await query("conversion")).toHaveLength(0);
  });

  it("refuses a missing or unknown actor or item", async () => {
    const { run, query } = await world();

    await expect(run("scflow/create_conversion", { from_item: "Bolt", to_item: "Nut" })).rejects.toThrow(/actor/);
    await expect(run("scflow/create_conversion", { actor: "Depot", to_item: "Nut" })).rejects.toThrow(/from_item/);
    await expect(run("scflow/create_conversion", { actor: "Depot", from_item: "Bolt" })).rejects.toThrow(/to_item/);
    await expect(
      run("scflow/create_conversion", { actor: "Ghost", from_item: "Bolt", to_item: "Nut" }),
    ).rejects.toThrow(/names no instance/);
    await expect(
      run("scflow/create_conversion", { actor: "Depot", from_item: "Ghost", to_item: "Nut" }),
    ).rejects.toThrow(/names no instance/);

    expect(await query("conversion")).toHaveLength(0);
  });
});

describe("scflow/update_conversion", () => {
  async function converted() {
    const ctx = await world();
    const conversion = await ctx.run("scflow/create_conversion", {
      actor: "Depot",
      from_item: "Bolt",
      to_item: "Nut",
      display_name: { en: "Machining" },
      description: { en: "Turns bolts into nuts" },
    });
    return { ...ctx, conversion };
  }

  it("replaces the given languages of the name and keeps the others", async () => {
    const { run, query, conversion } = await converted();

    const updated = await run("scflow/update_conversion", { id: conversion.id, display_name: { fr: "Usinage" } });

    expect(updated).toMatchObject({ id: conversion.id, display_name: { en: "Machining", fr: "Usinage" } });
    expect((await query("conversion"))[0].display_name).toEqual({ en: "Machining", fr: "Usinage" });
  });

  it("finds the conversion by its name and changes its description", async () => {
    const { run, query } = await converted();

    await run("scflow/update_conversion", { id: "Machining", description: { fr: "Transforme" } });

    expect((await query("conversion"))[0].description).toEqual({ en: "Turns bolts into nuts", fr: "Transforme" });
  });

  it("clears the name and the description with null", async () => {
    const { run, query, conversion } = await converted();

    await run("scflow/update_conversion", { id: conversion.id, display_name: null, description: null });

    const stored = (await query("conversion"))[0];
    expect(Object.keys(stored.display_name ?? {})).toHaveLength(0);
    expect(Object.keys(stored.description ?? {})).toHaveLength(0);
  });

  it("keeps the actor and the two items", async () => {
    const { run, query, conversion, depot, bolt, nut } = await converted();

    await run("scflow/update_conversion", { id: conversion.id, display_name: "Cutting" });

    expect((await query("conversion"))[0]).toMatchObject({ actor: depot.id, from_item: bolt.id, to_item: nut.id });
  });

  it("refuses a call that changes nothing and an unknown conversion", async () => {
    const { run, conversion } = await converted();

    await expect(run("scflow/update_conversion", { id: conversion.id })).rejects.toThrow(/must NOT have fewer/);
    await expect(run("scflow/update_conversion", { id: "missing", display_name: "X" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/update_conversion", { display_name: "X" })).rejects.toThrow(/conversion/);
  });
});

describe("scflow/delete_conversion", () => {
  it("deletes the conversion and its notes, and keeps the actor and the items", async () => {
    const { run, query } = await world();
    const conversion = await run("scflow/create_conversion", { actor: "Depot", from_item: "Bolt", to_item: "Nut" });
    await run("scflow/add_note", { annotated: conversion.id, content: "A note" });

    const result = await run("scflow/delete_conversion", { id: conversion.id });

    expect(result).toEqual({ id: conversion.id });
    expect(await query("conversion")).toHaveLength(0);
    expect(await query("note")).toHaveLength(0);
    expect(await query("actor")).toHaveLength(1);
    expect(await query("item")).toHaveLength(4);
  });

  it("refuses an unknown conversion", async () => {
    const { run } = await world();

    await expect(run("scflow/delete_conversion", { id: "missing" })).rejects.toThrow(/names no instance/);
  });
});

describe("deletions that reach conversions", () => {
  async function converted() {
    const ctx = await world();
    const conversion = await ctx.run("scflow/create_conversion", { actor: "Depot", from_item: "Bolt", to_item: "Nut" });
    return { ...ctx, conversion };
  }

  it("scflow/delete_item is refused while a conversion references the item, and counts it", async () => {
    const { run, query } = await converted();

    await expect(run("scflow/delete_item", { id: "Bolt" })).rejects.toMatchObject({ code: "constraint_violation" });
    await expect(run("scflow/delete_item", { id: "Nut" })).rejects.toMatchObject({ code: "constraint_violation" });

    expect(await query("conversion")).toHaveLength(1);
  });

  it("scflow/delete_item with cascade deletes the conversions that reference the item", async () => {
    const { run, query } = await converted();

    await run("scflow/delete_item", { id: "Nut", cascade: true });

    expect(await query("conversion")).toHaveLength(0);
    expect((await query("item")).map((item) => item.display_name.en).sort()).toEqual(["Bolt", "Euro", "Order"]);
  });

  it("scflow/delete_actor is refused while the actor owns a conversion, and counts it", async () => {
    const { run, query } = await converted();

    await expect(run("scflow/delete_actor", { id: "Depot" })).rejects.toMatchObject({ code: "constraint_violation" });

    expect(await query("conversion")).toHaveLength(1);
  });

  it("scflow/delete_actor with cascade deletes the conversions of the actor and keeps the items", async () => {
    const { run, query } = await converted();

    await run("scflow/delete_actor", { id: "Depot", cascade: true });

    expect(await query("conversion")).toHaveLength(0);
    expect(await query("item")).toHaveLength(4);
  });

  it("scflow/delete_item_type with cascade deletes the conversions of its items", async () => {
    const { run, query } = await converted();

    await run("scflow/delete_item_type", { id: "Part", cascade: true });

    expect(await query("conversion")).toHaveLength(0);
  });

  it("scflow/inspect_delete_impact lists the conversions that a cascade removes", async () => {
    const { run, conversion } = await converted();

    const byItem = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "item", ref: "Bolt" }] });
    const byActor = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "actor", ref: "Depot" }] });
    const direct = await run<any>("scflow/inspect_delete_impact", {
      targets: [{ schema: "conversion", ref: conversion.id }],
    });

    expect(byItem.cascaded.conversions).toHaveLength(1);
    expect(byItem.counts.conversions).toBe(1);
    expect(byItem.counts.total).toBe(1);
    expect(byActor.cascaded.conversions).toEqual([expect.objectContaining({ id: conversion.id })]);
    expect(direct.targets).toEqual([expect.objectContaining({ schema: "conversion", id: conversion.id })]);
    expect(direct.cascaded.conversions).toEqual([]);
    expect(direct.hasSideEffects).toBe(false);
  });
});

describe("conversion tags", () => {
  it("scflow/create_conversion stores the given tags, without duplicates", async () => {
    const { run, query } = await world();

    await run("scflow/create_conversion", {
      actor: "Depot",
      from_item: "Bolt",
      to_item: "Nut",
      tags: ["machining", "steel", "steel"],
    });

    expect((await query("conversion"))[0].tags).toEqual(["machining", "steel"]);
  });

  it("scflow/create_conversion refuses tags that are not a list of non-empty strings", async () => {
    const { run, query } = await world();

    await expect(
      run("scflow/create_conversion", { actor: "Depot", from_item: "Bolt", to_item: "Nut", tags: "steel" }),
    ).rejects.toThrow(/tags/);

    expect(await query("conversion")).toHaveLength(0);
  });

  it("scflow/update_conversion replaces the tags and clears them with an empty list", async () => {
    const { run, query } = await world();
    const conversion = await run("scflow/create_conversion", {
      actor: "Depot",
      from_item: "Bolt",
      to_item: "Nut",
      tags: ["a", "b"],
    });

    await run("scflow/update_conversion", { id: conversion.id, tags: ["c"] });
    expect((await query("conversion"))[0].tags).toEqual(["c"]);

    await run("scflow/update_conversion", { id: conversion.id, tags: [] });
    expect((await query("conversion"))[0].tags ?? []).toEqual([]);
  });

  it("scflow/add_tags and scflow/remove_tags work on a conversion, found by its id", async () => {
    const { run, query } = await world();
    const conversion = await run("scflow/create_conversion", {
      actor: "Depot",
      from_item: "Bolt",
      to_item: "Nut",
      tags: ["a"],
    });

    const added = await run<any>("scflow/add_tags", { entity: conversion.id, tags: ["a", "b"] });
    expect(added).toEqual({ id: conversion.id, tags: ["a", "b"] });

    const removed = await run<any>("scflow/remove_tags", { entity: conversion.id, tags: ["a"] });
    expect(removed).toEqual({ id: conversion.id, tags: ["b"] });
    expect((await query("conversion"))[0].tags).toEqual(["b"]);
  });

  it("scflow/add_tags accepts a conversion given by its name", async () => {
    const { run } = await world();
    await run("scflow/create_conversion", {
      actor: "Depot",
      from_item: "Bolt",
      to_item: "Nut",
      display_name: "Machining",
    });

    await expect(run("scflow/add_tags", { entity: "Machining", tags: ["steel"] })).resolves.toMatchObject({ tags: ["steel"] });
  });
});

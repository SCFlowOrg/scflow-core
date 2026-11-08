import { describe, expect, it } from "vitest";
import { setupActions as setup } from "./actions-helpers.js";

async function withUsages() {
  const ctx = await setup();
  const { create, run } = ctx;
  await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
  const a = await run("scflow/create_actor", { display_name: "A", type: "Site" });
  const b = await run("scflow/create_actor", { display_name: "B", type: "Site" });
  const partType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
  const toolType = await create("item_type", { display_name: { en: "Tool" }, domain: "physical" });
  const bolt = await create("item", { display_name: { en: "Bolt" }, type: partType });
  const nut = await create("item", { display_name: { en: "Nut" }, type: partType });
  const drill = await create("item", { display_name: { en: "Drill" }, type: toolType });
  const flowBolt = await create("flow", { source: a.id, destination: b.id, item: bolt });
  const flowNut = await create("flow", { source: a.id, destination: b.id, item: nut });
  const heldBolt = await create("item_at_actor", { actor: a.id, item: bolt });
  const heldNut = await create("item_at_actor", { actor: a.id, item: nut });
  const heldDrill = await create("item_at_actor", { actor: a.id, item: drill });
  const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
  const transformation = await create("transformation", {
    display_name: { en: "Assemble" },
    type: transformationType,
    actor: a.id,
  });
  const lineBolt = await create("transformation_line", { transformation, role: "consumed", held_item: heldBolt });
  const lineNut = await create("transformation_line", { transformation, role: "consumed", held_item: heldNut });
  await create("note", { annotated: bolt, content: { en: "Bolt note" } });
  await create("note", { annotated: heldBolt, content: { en: "Held bolt note" } });
  await create("note", { annotated: flowBolt, content: { en: "Flow bolt note" } });
  await create("note", { annotated: lineBolt, content: { en: "Line bolt note" } });
  await create("note", { annotated: nut, content: { en: "Nut note" } });
  return {
    ...ctx,
    partType,
    toolType,
    bolt,
    nut,
    drill,
    flowNut,
    heldNut,
    heldDrill,
    transformation,
    lineNut,
  };
}

describe("scflow/delete_item", () => {
  it("deletes an item given by name that nothing uses", async () => {
    const { run, query, create } = await setup();
    const type = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    await create("item", { display_name: { en: "Spare" }, type });

    const result = await run("scflow/delete_item", { id: "Spare" });

    expect(typeof result.id).toBe("string");
    expect(await query("item")).toHaveLength(0);
  });

  it("refuses an item that is held or carried by a flow without cascade, and removes nothing", async () => {
    const { run, query } = await withUsages();

    await expect(run("scflow/delete_item", { id: "Bolt" })).rejects.toThrow(/held item.*flow/);

    expect(await query("item")).toHaveLength(3);
    expect(await query("item_at_actor")).toHaveLength(3);
    expect(await query("flow")).toHaveLength(2);
    expect(await query("transformation_line")).toHaveLength(2);
  });

  it("deletes the held instances, the flows that carry the item, their lines and every note with cascade, and nothing else", async () => {
    const { run, query, nut, heldNut, flowNut, lineNut, heldDrill, transformation } = await withUsages();

    await run("scflow/delete_item", { id: "Bolt", cascade: true });

    expect((await query("item")).map((item) => item.id).sort()).toHaveLength(2);
    expect((await query("item_at_actor")).map((held) => held.id).sort()).toEqual([heldDrill, heldNut].sort());
    expect((await query("flow")).map((flow) => flow.id)).toEqual([flowNut]);
    expect((await query("transformation_line")).map((line) => line.id)).toEqual([lineNut]);
    expect((await query("note")).map((note) => note.content)).toEqual([{ en: "Nut note" }]);
    expect(await query("item", { id: nut })).toHaveLength(1);
    expect(await query("transformation", { id: transformation })).toHaveLength(1);
    expect(await query("actor")).toHaveLength(2);
  });

  it("refuses an unknown item", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_item", { id: "Ghost" })).rejects.toThrow(/names no instance/);
  });
});

describe("scflow/delete_item_type", () => {
  it("deletes an item type that no item uses, given by name", async () => {
    const { run, query, create } = await setup();
    await create("item_type", { display_name: { en: "Unused" }, domain: "physical" });

    await run("scflow/delete_item_type", { id: "Unused" });

    expect(await query("item_type")).toHaveLength(0);
  });

  it("refuses a type that items use without cascade, and removes nothing", async () => {
    const { run, query } = await withUsages();

    await expect(run("scflow/delete_item_type", { id: "Part" })).rejects.toThrow(/item/);

    expect(await query("item_type")).toHaveLength(2);
    expect(await query("item")).toHaveLength(3);
  });

  it("deletes the items of the type with their usages, and the type, with cascade", async () => {
    const { run, query, toolType, drill, heldDrill } = await withUsages();

    await run("scflow/delete_item_type", { id: "Part", cascade: true });

    expect((await query("item_type")).map((type) => type.id)).toEqual([toolType]);
    expect((await query("item")).map((item) => item.id)).toEqual([drill]);
    expect((await query("item_at_actor")).map((held) => held.id)).toEqual([heldDrill]);
    expect(await query("flow")).toHaveLength(0);
    expect(await query("transformation_line")).toHaveLength(0);
    expect(await query("note")).toHaveLength(0);
  });

  it("refuses an unknown type", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_item_type", { id: "Ghost" })).rejects.toThrow(/names no instance/);
  });
});

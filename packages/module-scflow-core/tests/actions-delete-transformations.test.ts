import { describe, expect, it } from "vitest";
import { setupActions as setup } from "./actions-helpers.js";

async function withTransformations() {
  const ctx = await setup();
  const { create, run } = ctx;
  await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
  const plant = await run("scflow/create_actor", { display_name: "Plant", type: "Site" });
  const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
  const bolt = await create("item", { display_name: { en: "Bolt" }, type: itemType });
  const heldBolt = await create("item_at_actor", { actor: plant.id, item: bolt });
  const assembly = await create("transformation_type", { display_name: { en: "Assembly" } });
  const inspection = await create("transformation_type", { display_name: { en: "Inspection" } });
  const assemble = await create("transformation", {
    display_name: { en: "Assemble" },
    type: assembly,
    actor: plant.id,
  });
  const assembleAgain = await create("transformation", {
    display_name: { en: "Assemble again" },
    type: assembly,
    actor: plant.id,
  });
  const inspect = await create("transformation", {
    display_name: { en: "Inspect" },
    type: inspection,
    actor: plant.id,
  });
  const lineAssemble = await create("transformation_line", {
    transformation: assemble,
    role: "consumed",
    held_item: heldBolt,
  });
  await create("transformation_line", { transformation: assembleAgain, role: "produced", held_item: heldBolt });
  const lineInspect = await create("transformation_line", { transformation: inspect, role: "consumed", held_item: heldBolt });
  await create("note", { annotated: assemble, content: { en: "Assemble note" } });
  await create("note", { annotated: lineAssemble, content: { en: "Line note" } });
  await create("note", { annotated: inspect, content: { en: "Inspect note" } });
  return { ...ctx, plant, heldBolt, assembly, inspection, inspect, lineInspect };
}

describe("scflow/delete_transformation", () => {
  it("deletes a transformation given by name with its lines and notes, and keeps the held item", async () => {
    const { run, query, heldBolt, inspect, lineInspect } = await withTransformations();

    const result = await run("scflow/delete_transformation", { id: "Assemble" });

    expect(typeof result.id).toBe("string");
    expect((await query("transformation")).map((transformation) => transformation.id)).toHaveLength(2);
    expect((await query("transformation_line")).map((line) => line.id)).toHaveLength(2);
    expect((await query("transformation_line", { id: lineInspect })).map((line) => line.transformation)).toEqual([
      inspect,
    ]);
    expect((await query("note")).map((note) => note.content)).toEqual([{ en: "Inspect note" }]);
    expect(await query("item_at_actor", { id: heldBolt })).toHaveLength(1);
  });

  it("deletes the transformation whether cascade is true or false", async () => {
    const { run, query } = await withTransformations();

    await run("scflow/delete_transformation", { id: "Inspect", cascade: false });
    await run("scflow/delete_transformation", { id: "Assemble", cascade: true });

    expect(await query("transformation")).toHaveLength(1);
  });

  it("refuses an unknown transformation", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_transformation", { id: "Ghost" })).rejects.toThrow(/names no instance/);
  });
});

describe("scflow/delete_transformation_type", () => {
  it("deletes a type that no transformation uses, given by name", async () => {
    const { run, query, create } = await setup();
    await create("transformation_type", { display_name: { en: "Unused" } });

    await run("scflow/delete_transformation_type", { id: "Unused" });

    expect(await query("transformation_type")).toHaveLength(0);
  });

  it("refuses a type that transformations use without cascade, and removes nothing", async () => {
    const { run, query } = await withTransformations();

    await expect(run("scflow/delete_transformation_type", { id: "Assembly" })).rejects.toMatchObject({ code: "constraint_violation" });

    expect(await query("transformation_type")).toHaveLength(2);
    expect(await query("transformation")).toHaveLength(3);
  });

  it("deletes the transformations of the type with their lines and notes, and the type, with cascade", async () => {
    const { run, query, inspection, inspect, heldBolt } = await withTransformations();

    await run("scflow/delete_transformation_type", { id: "Assembly", cascade: true });

    expect((await query("transformation_type")).map((type) => type.id)).toEqual([inspection]);
    expect((await query("transformation")).map((transformation) => transformation.id)).toEqual([inspect]);
    expect(await query("transformation_line")).toHaveLength(1);
    expect((await query("note")).map((note) => note.content)).toEqual([{ en: "Inspect note" }]);
    expect(await query("item_at_actor", { id: heldBolt })).toHaveLength(1);
  });

  it("refuses an unknown type", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_transformation_type", { id: "Ghost" })).rejects.toThrow(/names no instance/);
  });
});

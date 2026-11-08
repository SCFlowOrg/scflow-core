import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

/**
 * A network with two physical and information sites "Plant" and "Annex", a financial
 * actor "Bank", the physical items "Bolt" and "Frame", the information item "Order",
 * the financial item "Euro", and the transformation type "Assembly".
 */
async function world() {
  const ctx = await setup();
  const { run } = ctx;
  await run("scflow/create_actor_type", { display_name: "Site", domains: ["physical", "information"] });
  await run("scflow/create_actor_type", { display_name: "Finance", domains: ["financial"] });
  const plant = await run("scflow/create_actor", { display_name: "Plant", type: "Site" });
  const annex = await run("scflow/create_actor", { display_name: "Annex", type: "Site" });
  await run("scflow/create_actor", { display_name: "Bank", type: "Finance" });
  await run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
  await run("scflow/create_item_type", { display_name: "Message", domain: "information" });
  await run("scflow/create_item_type", { display_name: "Money", domain: "financial" });
  const bolt = await run("scflow/create_item", { display_name: "Bolt", type: "Part" });
  const frame = await run("scflow/create_item", { display_name: "Frame", type: "Part" });
  const order = await run("scflow/create_item", { display_name: "Order", type: "Message" });
  await run("scflow/create_item", { display_name: "Euro", type: "Money" });
  const assembly = await run("scflow/create_transformation_type", { display_name: "Assembly" });
  return { ...ctx, plant, annex, bolt, frame, order, assembly };
}

describe("transformation actions", () => {
  it("are declared with scoped unique ids, and the catalog has all 34 actions", () => {
    const ids = ACTIONS.map((action) => action.id);

    for (const id of [
      "scflow/create_transformation_type",
      "scflow/create_transformation",
      "scflow/connect_transformation_line",
      "scflow/define_process",
      "scflow/delete_transformation",
      "scflow/delete_transformation_type",
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(34);
  });
});

describe("scflow/create_transformation_type", () => {
  it("creates a transformation type and returns it", async () => {
    const { run, query } = await setup();

    const type = await run("scflow/create_transformation_type", {
      display_name: { en: "Assembly", fr: "Assemblage" },
      description: "Put parts together",
    });

    expect(type).toMatchObject({ display_name: { en: "Assembly", fr: "Assemblage" } });
    const stored = await query("transformation_type");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: type.id, description: { en: "Put parts together" } });
  });

  it("refuses a missing name and writes nothing", async () => {
    const { run, query } = await setup();

    await expect(run("scflow/create_transformation_type", {})).rejects.toThrow(/name/);

    expect(await query("transformation_type")).toHaveLength(0);
  });
});

describe("scflow/create_transformation", () => {
  it("creates a transformation at an actor, both given by name, named after its type", async () => {
    const { run, plant, assembly } = await world();

    const transformation = await run("scflow/create_transformation", { actor: "Plant", type: "Assembly" });

    expect(transformation).toMatchObject({
      display_name: { en: "Assembly" },
      type: assembly.id,
      actor: plant.id,
    });
    expect(typeof transformation.id).toBe("string");
  });

  it("takes the given name", async () => {
    const { run } = await world();

    const transformation = await run("scflow/create_transformation", {
      actor: "Plant",
      type: "Assembly",
      display_name: { en: "Assemble frames", fr: "Assembler les cadres" },
    });

    expect(transformation.display_name).toEqual({ en: "Assemble frames", fr: "Assembler les cadres" });
  });

  it("refuses an unknown actor or type and writes nothing", async () => {
    const { run, query } = await world();

    await expect(run("scflow/create_transformation", { actor: "Ghost", type: "Assembly" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/create_transformation", { actor: "Plant", type: "Ghost" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/create_transformation", { type: "Assembly" })).rejects.toThrow(/actor/);

    expect(await query("transformation")).toHaveLength(0);
  });
});

describe("scflow/connect_transformation_line", () => {
  async function withHeld() {
    const ctx = await world();
    const transformation = await ctx.run("scflow/create_transformation", {
      actor: "Plant",
      type: "Assembly",
      display_name: "Assemble",
    });
    const heldBolt = await ctx.run("scflow/hold_item", { actor: "Plant", item: "Bolt" });
    const heldFrame = await ctx.run("scflow/hold_item", { actor: "Plant", item: "Frame" });
    return { ...ctx, transformation, heldBolt, heldFrame };
  }

  it("connects a held item to a transformation given by name", async () => {
    const { run, query, transformation, heldBolt } = await withHeld();

    const line = await run("scflow/connect_transformation_line", {
      transformation: "Assemble",
      held_item: heldBolt.id,
      role: "consumed",
    });

    expect(line).toMatchObject({ transformation: transformation.id, held_item: heldBolt.id, role: "consumed" });
    expect(typeof line.id).toBe("string");
    expect(await query("transformation_line")).toHaveLength(1);
  });

  it("returns the existing line for the same held item and the same role", async () => {
    const { run, query, heldBolt } = await withHeld();
    const first = await run("scflow/connect_transformation_line", {
      transformation: "Assemble",
      held_item: heldBolt.id,
      role: "consumed",
    });

    const second = await run("scflow/connect_transformation_line", {
      transformation: "Assemble",
      held_item: heldBolt.id,
      role: "consumed",
    });

    expect(second.id).toBe(first.id);
    expect(await query("transformation_line")).toHaveLength(1);
  });

  it("lets one held item be consumed and produced by the same transformation", async () => {
    const { run, query, heldBolt } = await withHeld();

    await run("scflow/connect_transformation_line", { transformation: "Assemble", held_item: heldBolt.id, role: "consumed" });
    await run("scflow/connect_transformation_line", { transformation: "Assemble", held_item: heldBolt.id, role: "produced" });

    expect(await query("transformation_line")).toHaveLength(2);
  });

  it("refuses an item held by another actor than the actor of the transformation", async () => {
    const { run, query } = await withHeld();
    const heldAtAnnex = await run("scflow/hold_item", { actor: "Annex", item: "Bolt" });

    await expect(
      run("scflow/connect_transformation_line", {
        transformation: "Assemble",
        held_item: heldAtAnnex.id,
        role: "consumed",
      }),
    ).rejects.toMatchObject({ code: "rule_violation", details: { rule: "transformation_line_actor" } });

    expect(await query("transformation_line")).toHaveLength(0);
  });

  it("refuses an unknown role, naming the parameter", async () => {
    const { run, heldBolt } = await withHeld();

    await expect(
      run("scflow/connect_transformation_line", { transformation: "Assemble", held_item: heldBolt.id, role: "moved" }),
    ).rejects.toThrow(/role/);
    await expect(
      run("scflow/connect_transformation_line", { transformation: "Assemble", held_item: heldBolt.id }),
    ).rejects.toThrow(/role/);
  });

  it("refuses an unknown transformation or held item", async () => {
    const { run, heldBolt } = await withHeld();

    await expect(
      run("scflow/connect_transformation_line", { transformation: "Ghost", held_item: heldBolt.id, role: "consumed" }),
    ).rejects.toThrow(/names no instance/);
    await expect(
      run("scflow/connect_transformation_line", { transformation: "Assemble", held_item: "missing", role: "consumed" }),
    ).rejects.toThrow(/names no instance/);
  });

  it("refuses a transformation name shared by several transformations", async () => {
    const { run, heldBolt } = await withHeld();
    await run("scflow/create_transformation", { actor: "Annex", type: "Assembly", display_name: "Assemble" });

    const error = await run("scflow/connect_transformation_line", {
      transformation: "Assemble",
      held_item: heldBolt.id,
      role: "consumed",
    }).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/names several instance/);
  });
});

describe("scflow/define_process", () => {
  it("creates the transformation, holds the missing items and attaches every line", async () => {
    const { run, query, plant, bolt, frame, assembly } = await world();
    await run("scflow/hold_item", { actor: "Plant", item: "Bolt" });

    const result = await run<Record<string, any>>("scflow/define_process", {
      actor: "Plant",
      transformation_type: "Assembly",
      consumed_items: ["Bolt"],
      produced_items: ["Frame"],
    });

    expect(result.transformation).toMatchObject({
      display_name: { en: "Assembly" },
      type: assembly.id,
      actor: plant.id,
    });
    expect(result.lines.map((line: any) => line.role)).toEqual(["consumed", "produced"]);
    for (const line of result.lines) {
      expect(line.transformation).toBe(result.transformation.id);
    }
    const held = await query("item_at_actor");
    expect(held).toHaveLength(2);
    expect(held.map((record) => record.item).sort()).toEqual([bolt.id, frame.id].sort());
    expect(await query("transformation_line")).toHaveLength(2);
  });

  it("reuses a held item that exists instead of creating a second record", async () => {
    const { run, query } = await world();
    const existing = await run("scflow/hold_item", { actor: "Plant", item: "Bolt" });

    const result = await run<Record<string, any>>("scflow/define_process", {
      actor: "Plant",
      transformation_type: "Assembly",
      consumed_items: ["Bolt"],
    });

    expect(result.lines[0].held_item).toBe(existing.id);
    expect(await query("item_at_actor")).toHaveLength(1);
  });

  it("counts an item listed twice once, and lets an item be consumed and produced", async () => {
    const { run, query } = await world();

    const result = await run<Record<string, any>>("scflow/define_process", {
      actor: "Plant",
      transformation_type: "Assembly",
      consumed_items: ["Bolt", "Bolt"],
      produced_items: ["Bolt"],
    });

    expect(result.lines.map((line: any) => line.role)).toEqual(["consumed", "produced"]);
    expect(await query("item_at_actor")).toHaveLength(1);
  });

  it("creates a transformation without lines when no item is given", async () => {
    const { run, query } = await world();

    const result = await run<Record<string, any>>("scflow/define_process", {
      actor: "Plant",
      transformation_type: "Assembly",
    });

    expect(result.lines).toEqual([]);
    expect(await query("transformation")).toHaveLength(1);
    expect(await query("item_at_actor")).toHaveLength(0);
  });

  it("accepts ids for the actor, the type and the items", async () => {
    const { run, plant, bolt, assembly } = await world();

    const result = await run<Record<string, any>>("scflow/define_process", {
      actor: plant.id,
      transformation_type: assembly.id,
      consumed_items: [bolt.id],
    });

    expect(result.lines).toHaveLength(1);
  });

  it("writes nothing when an item is outside the domains of the actor", async () => {
    const { run, query } = await world();

    await expect(
      run("scflow/define_process", {
        actor: "Plant",
        transformation_type: "Assembly",
        consumed_items: ["Bolt"],
        produced_items: ["Euro"],
      }),
    ).rejects.toMatchObject({ code: "rule_violation", details: { rule: "held_item_domain" } });

    expect(await query("transformation")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);
    expect(await query("transformation_line")).toHaveLength(0);
  });

  it("writes nothing when an item, the actor or the type is unknown, naming the parameter", async () => {
    const { run, query } = await world();

    await expect(
      run("scflow/define_process", { actor: "Plant", transformation_type: "Assembly", consumed_items: ["Ghost"] }),
    ).rejects.toThrow(/names no instance/);
    await expect(
      run("scflow/define_process", { actor: "Ghost", transformation_type: "Assembly" }),
    ).rejects.toThrow(/names no instance/);
    await expect(
      run("scflow/define_process", { actor: "Plant", transformation_type: "Ghost" }),
    ).rejects.toThrow(/names no instance/);
    await expect(
      run("scflow/define_process", { actor: "Plant", transformation_type: "Assembly", consumed_items: "Bolt" }),
    ).rejects.toThrow(/consumed_items/);

    expect(await query("transformation")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);
  });
});

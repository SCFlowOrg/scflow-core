import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

async function withNetwork() {
  const ctx = await setup();
  const { create, run } = ctx;
  await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
  const campus = await run("scflow/create_actor", { display_name: "Campus", type: "Site" });
  const dock = await run("scflow/create_actor", { display_name: "Dock", type: "Site", parent_actor: "Campus" });
  const bay = await run("scflow/create_actor", { display_name: "Bay", type: "Site", parent_actor: "Dock" });
  const outside = await run("scflow/create_actor", { display_name: "Outside", type: "Site" });
  const hub = await run("scflow/create_actor", { display_name: "Hub", type: "Site" });
  const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
  const bolt = await create("item", { display_name: { en: "Bolt" }, type: itemType });
  const nut = await create("item", { display_name: { en: "Nut" }, type: itemType });
  const heldDock = await create("item_at_actor", { actor: dock.id, item: bolt });
  const heldBay = await create("item_at_actor", { actor: bay.id, item: bolt });
  const heldOutside = await create("item_at_actor", { actor: outside.id, item: bolt });
  const flowIn = await create("flow", { source: outside.id, destination: bay.id, item: bolt });
  const flowOut = await create("flow", { source: dock.id, destination: outside.id });
  await create("flow", { source: hub.id, destination: outside.id });
  const heldNut = await create("item_at_actor", { actor: outside.id, item: nut });
  const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
  const assemble = await create("transformation", { display_name: { en: "Assemble" }, type: transformationType, actor: bay.id });
  await create("transformation", { display_name: { en: "Pack" }, type: transformationType, actor: dock.id });
  const line = await create("transformation_line", { transformation: assemble, role: "consumed", held_item: heldBay });
  await create("note", { annotated: bay.id, content: { en: "Bay note" } });
  await create("note", { annotated: heldDock, content: { en: "Held note" } });
  await create("note", { annotated: flowIn, content: { en: "Flow note" } });
  await create("note", { annotated: line, content: { en: "Line note" } });
  await create("note", { annotated: outside.id, content: { en: "Outside note" } });
  return { ...ctx, campus, dock, bay, outside, hub, bolt, nut, flowIn, flowOut, heldOutside, heldDock, heldBay, heldNut };
}

const names = (entries: { label: string }[]) => entries.map((entry) => entry.label).sort();

describe("scflow/inspect_delete_impact", () => {
  it("is a read action registered in ACTIONS", () => {
    const action = ACTIONS.find((candidate) => candidate.id === "scflow/inspect_delete_impact");

    expect(action).toBeDefined();
    expect(action?.kind).toBe("read");
  });

  it("reports the descendants, flows, held items, transformations, lines and notes of an actor", async () => {
    const { run, campus, dock, bay, heldDock, heldBay, flowIn, flowOut } = await withNetwork();

    const impact = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "actor", ref: "Campus" }] });

    expect(impact.targets).toEqual([{ schema: "actor", id: campus.id, label: "Campus" }]);
    expect(impact.cascaded.actors).toEqual(
      expect.arrayContaining([
        { id: dock.id, label: "Dock", isChild: true },
        { id: bay.id, label: "Bay", isChild: true },
      ]),
    );
    expect(impact.cascaded.actors).toHaveLength(2);
    expect(impact.cascaded.flows.map((flow: any) => flow.id).sort()).toEqual([flowIn, flowOut].sort());
    expect(impact.cascaded.heldItems.map((held: any) => held.id).sort()).toEqual([heldDock, heldBay].sort());
    expect(impact.cascaded.heldItems[0]).toMatchObject({ itemName: "Bolt" });
    expect(names(impact.cascaded.transformations)).toEqual(["Assemble", "Pack"]);
    expect(impact.cascaded.items).toEqual([]);
    expect(impact.cascaded.transformationLines).toBe(1);
    expect(impact.cascaded.notes).toBe(4);
    expect(impact.counts).toEqual({
      actors: 2,
      flows: 2,
      items: 0,
      heldItems: 2,
      transformations: 2,
      transformationLines: 1,
      conversions: 0,
      notes: 4,
      total: 13,
    });
    expect(impact.hasSideEffects).toBe(true);
  });

  it("counts an entity once when a parent actor and its descendants are all targets", async () => {
    const { run, query } = await withNetwork();

    const impact = await run<any>("scflow/inspect_delete_impact", {
      targets: [
        { schema: "actor", ref: "Campus" },
        { schema: "actor", ref: "Dock" },
        { schema: "actor", ref: "Bay" },
        { schema: "actor", ref: "Campus" },
      ],
    });

    expect(impact.targets.map((target: any) => target.label)).toEqual(["Campus", "Dock", "Bay"]);
    expect(impact.cascaded.actors).toEqual([]);
    expect(impact.counts).toEqual({
      actors: 0,
      flows: 2,
      items: 0,
      heldItems: 2,
      transformations: 2,
      transformationLines: 1,
      conversions: 0,
      notes: 4,
      total: 11,
    });
    expect(await query("actor")).toHaveLength(5);
  });

  it("reports the actors of a type, flagging the ones that are children", async () => {
    const { run, campus, dock, bay, outside, hub } = await withNetwork();

    const impact = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "actor_type", ref: "Site" }] });

    expect(impact.cascaded.actors).toHaveLength(5);
    const flagged = impact.cascaded.actors.filter((actor: any) => actor.isChild).map((actor: any) => actor.id);
    expect(flagged.sort()).toEqual([dock.id, bay.id].sort());
    const roots = impact.cascaded.actors.filter((actor: any) => !actor.isChild).map((actor: any) => actor.id);
    expect(roots.sort()).toEqual([campus.id, outside.id, hub.id].sort());
    expect(impact.counts.flows).toBe(3);
    expect(impact.counts.notes).toBe(5);
  });

  it("reports the usages of an item, the flows that carry it included", async () => {
    const { run, heldDock, heldBay, heldOutside, flowIn } = await withNetwork();

    const impact = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "item", ref: "Bolt" }] });

    expect(impact.cascaded.heldItems.map((held: any) => held.id).sort()).toEqual([heldDock, heldBay, heldOutside].sort());
    expect(impact.cascaded.flows.map((flow: any) => flow.id)).toEqual([flowIn]);
    expect(impact.counts).toMatchObject({ actors: 0, flows: 1, heldItems: 3, transformationLines: 1, notes: 3, total: 8 });
  });

  it("reports what a flow, a transformation type and a scope would remove", async () => {
    const { run, flowIn, create } = await withNetwork();
    const scope = await create("scope", { display_name: { en: "Make" } });

    const flow = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "flow", ref: flowIn }] });
    const type = await run<any>("scflow/inspect_delete_impact", {
      targets: [{ schema: "transformation_type", ref: "Assembly" }],
    });
    const emptyScope = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "scope", ref: "Make" }] });

    expect(flow.counts).toMatchObject({ notes: 1, total: 1 });
    expect(flow.targets[0].label).toBe("Outside → Bay");
    expect(type.counts).toMatchObject({ transformations: 2, transformationLines: 1, notes: 1, total: 4 });
    expect(emptyScope.targets[0].id).toBe(scope);
    expect(emptyScope.hasSideEffects).toBe(false);
  });

  it("reports no side effect for a held item that no line uses", async () => {
    const { run, heldNut } = await withNetwork();

    const impact = await run<any>("scflow/inspect_delete_impact", { targets: [{ schema: "item_at_actor", ref: heldNut }] });

    expect(impact.counts.total).toBe(0);
    expect(impact.hasSideEffects).toBe(false);
  });

  it("changes nothing", async () => {
    const { run, query } = await withNetwork();
    const before = [await query("actor"), await query("flow"), await query("note")].map((rows) => rows.length);

    await run("scflow/inspect_delete_impact", { targets: [{ schema: "actor_type", ref: "Site" }] });

    expect([await query("actor"), await query("flow"), await query("note")].map((rows) => rows.length)).toEqual(before);
  });

  it("refuses a call without targets, an unknown schema and an unknown reference", async () => {
    const { run } = await withNetwork();

    await expect(run("scflow/inspect_delete_impact", { targets: [] })).rejects.toThrow(/targets/);
    await expect(run("scflow/inspect_delete_impact", {})).rejects.toThrow(/targets/);
    await expect(
      run("scflow/inspect_delete_impact", { targets: [{ schema: "note", ref: "x" }] }),
    ).rejects.toThrow(/schema/);
    await expect(
      run("scflow/inspect_delete_impact", { targets: [{ schema: "actor", ref: "Ghost" }] }),
    ).rejects.toThrow(/ref/);
  });
});

import { describe, expect, it } from "vitest";
import { exportSheets, importSheets } from "@scfloworg/spreadsheet";
import { setupActions } from "./actions-helpers.js";

/**
 * A whole dataset of scflow:core leaves through `@scfloworg/spreadsheet` and comes back identical:
 * every entity type has a sheet, the entities that have no name are found by their `unique` group, and
 * nothing is written that the actions of the module would refuse.
 */

const SCHEMAS = ["scope", "actor_type", "item_type", "location", "actor", "item", "mode", "route", "route_stop", "flow", "item_at_actor", "transformation_type", "transformation", "transformation_line", "conversion", "note"];

/** A network with every kind of entity, in two languages, with two plants that each have a `Line 1`. */
async function network() {
  const ctx = await setupActions({ languages: ["fr", "en"] });
  const { run } = ctx;
  await run("scflow/create_scope", { name: { fr: "Usines", en: "Plants" } });
  await run("scflow/create_actor_type", { name: { fr: "Site", en: "Site" }, domains: ["physical", "information"], default_scope: "Plants" });
  await run("scflow/create_actor_type", { name: "Machine", domains: ["physical"] });
  await run("scflow/create_item_type", { name: { fr: "Pièce", en: "Part" }, domain: "physical" });
  await run("scflow/create_location", { name: "Lyon site", city: "Lyon", country_code: "FR" });
  await run("scflow/create_actor", { name: "Lyon", type: "Site", location: "Lyon site", description: { fr: "Usine de Lyon", en: "Lyon plant" }, tags: ["main"] });
  await run("scflow/create_actor", { name: "Paris", type: "Site" });
  await run("scflow/create_actor", { name: "Line 1", type: "Machine", parent_actor: "Lyon" });
  await run("scflow/create_actor", { name: "Line 1", type: "Machine", parent_actor: "Paris" });
  await run("scflow/create_item", { name: "Bolt", type: "Part" });
  await run("scflow/create_item", { name: "Frame", type: "Part" });
  await run("scflow/hold_item", { actor: "Lyon", item: "Bolt" });
  await run("scflow/hold_item", { actor: "Paris", item: "Bolt" });
  const frame = await run("scflow/hold_item", { actor: "Lyon", item: "Frame" });
  await run("scflow/create_mode", { name: { fr: "Route", en: "Road" }, domain: "physical" });
  await run("scflow/create_route", { name: "Shuttle", mode: "Road", schedule: { fr: "Chaque lundi", en: "Every Monday" } });
  await run("scflow/add_route_stop", { route: "Shuttle", actor: "Lyon" });
  await run("scflow/add_route_stop", { route: "Shuttle", actor: "Paris", lead_time: "P1D" });
  const flow = await run("scflow/create_flow", { source: "Lyon", destination: "Paris", item: "Bolt" });
  await run("scflow/set_flow_route", { id: flow.id, route: "Shuttle" });
  await run("scflow/create_flow", { source: "Paris", destination: "Lyon" });
  await run("scflow/create_transformation_type", { name: "Assembly" });
  await run("scflow/create_transformation", { actor: "Lyon", type: "Assembly", name: "Assemble" });
  const held = (await ctx.query("item_at_actor")).find((h) => h.item === frame.item)!;
  await run("scflow/connect_transformation_line", { transformation: "Assemble", held_item: held.id, role: "produced" });
  await run("scflow/create_conversion", { actor: "Lyon", from_item: "Bolt", to_item: "Frame" });
  const lyon = (await ctx.query("actor")).find((a) => a.name === "Lyon")!;
  await run("scflow/add_note", { annotated: lyon.id, content: { fr: "Vérifier", en: "Check" } });
  await run("scflow/add_note", { annotated: flow.id, content: "Weekly" });
  return ctx;
}

const counts = async (ctx: Awaited<ReturnType<typeof network>>) => Object.fromEntries(await Promise.all(SCHEMAS.map(async (s) => [s, (await ctx.query(s)).length])));

describe("the whole dataset of scflow:core through sheets", () => {
  it("has a sheet for every entity type, with no id in it", async () => {
    const ctx = await network();
    const { sheets, skipped } = await exportSheets(ctx.dataset as never);
    expect(sheets.map((s) => s.schema?.replace("scflow.", "")).sort()).toEqual([...SCHEMAS].sort());
    expect(skipped).toEqual([]);
    expect(JSON.stringify(sheets)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    expect(sheets.find((s) => s.name === "flow")!.rows.map((r) => [r.source, r.destination, r.item])).toEqual([
      ["Lyon", "Paris", "Bolt"],
      ["Paris", "Lyon", null],
    ]);
  });

  it("rebuilds an empty dataset from its own sheets, and the export is the same", async () => {
    const ctx = await network();
    const exported = await exportSheets(ctx.dataset as never);
    const copy = await setupActions({ languages: ["fr", "en"] });
    const report = await importSheets(copy.dataset as never, exported.sheets);
    expect(report.rows.filter((r) => r.status === "refused")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(await counts(copy)).toEqual(await counts(ctx));
    expect((await exportSheets(copy.dataset as never)).sheets).toEqual(exported.sheets);
  });

  it("imports its own sheets into itself without changing a thing", async () => {
    const ctx = await network();
    const before = await counts(ctx);
    const report = await importSheets(ctx.dataset as never, (await exportSheets(ctx.dataset as never)).sheets);
    expect(report.rows.filter((r) => r.status !== "unchanged")).toEqual([]);
    expect(await counts(ctx)).toEqual(before);
  });

  it("writes a row added to one sheet through the actions of the module, which check its rules", async () => {
    const ctx = await network();
    const { sheets } = await exportSheets(ctx.dataset as never);
    const flows = sheets.find((s) => s.name === "flow")!;
    flows.rows.push({ ...flows.rows[0], source: "Paris", destination: "Lyon", item: "Bolt", route: null }); // both ends hold Bolt
    const report = await importSheets(ctx.dataset as never, [flows]);
    expect(report).toMatchObject({ ok: true, created: 1, unchanged: 2 });
    expect(await ctx.query("flow")).toHaveLength(3);

    await ctx.run("scflow/create_item_type", { name: "Money", domain: "financial" });
    await ctx.run("scflow/create_item", { name: "Euro", type: "Money" });
    flows.rows.push({ ...flows.rows[0], source: "Paris", destination: "Lyon", item: "Euro", route: null }); // no site moves money
    const refused = await importSheets(ctx.dataset as never, [flows]);
    expect(refused.ok).toBe(false);
    expect(refused.rows.at(-1)).toMatchObject({ status: "refused", code: "rule_violation" });
    expect(await ctx.query("flow")).toHaveLength(3);
  });
});

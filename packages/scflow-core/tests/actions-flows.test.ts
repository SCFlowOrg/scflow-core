import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

/** Creates two actors, "Source" and "Target", whose types have the given flow domains. */
async function withActors(sourceDomains: string[], targetDomains: string[]) {
  const ctx = await setup();
  await ctx.run("scflow/create_actor_type", { display_name: "From", domains: sourceDomains });
  await ctx.run("scflow/create_actor_type", { display_name: "To", domains: targetDomains });
  const source = await ctx.run("scflow/create_actor", { display_name: "Source", type: "From" });
  const target = await ctx.run("scflow/create_actor", { display_name: "Target", type: "To" });
  return { ...ctx, source, target };
}

describe("flow actions", () => {
  it("are declared with scoped unique ids", () => {
    const ids = ACTIONS.map((action) => action.id);

    expect(ids).toContain("scflow/create_flow");
    expect(ids).not.toContain("scflow/connect_actors");
    expect(ids).toContain("scflow/set_flow_item");
    expect(ids).toContain("scflow/delete_flow");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scflow/create_flow", () => {
  it("creates one flow between actors given by name", async () => {
    const { run, query, source, target } = await withActors(["physical", "information"], ["physical", "information"]);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
    });

    expect(typeof flow.id).toBe("string");
    expect(flow).toMatchObject({ source: source.id, destination: target.id, bidirectional: false });
    expect(flow).not.toHaveProperty("domain");
    expect(await query("flow")).toHaveLength(1);
  });

  it("accepts actor ids", async () => {
    const { run, source, target } = await withActors(["physical"], ["physical"]);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: source.id,
      destination: target.id,
    });

    expect(flow).toMatchObject({ source: source.id, destination: target.id });
  });

  it("creates a flow even when the actors share no flow domain", async () => {
    const { run, query } = await withActors(["physical"], ["service"]);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
    });

    expect(typeof flow.id).toBe("string");
    expect(await query("flow")).toHaveLength(1);
  });

  it("carries the item given by name, makes both ends hold it, and returns it", async () => {
    const { run, query, create, source, target } = await withActors(["physical"], ["physical"]);
    const type = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    const item = await create("item", { display_name: { en: "Bolt" }, type });

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
      item: "Bolt",
    });

    expect(flow).toMatchObject({ source: source.id, destination: target.id, item });
    const held = (await query("item_at_actor")).map((record) => `${record.actor}/${record.item}`).sort();
    expect(held).toEqual([`${source.id}/${item}`, `${target.id}/${item}`].sort());
  });

  it("returns no item for a flow that carries none", async () => {
    const { run } = await withActors(["physical"], ["physical"]);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", { source: "Source", destination: "Target" });

    expect(flow).not.toHaveProperty("item");
  });

  it("refuses an item whose domain does not fit an end, and creates nothing", async () => {
    const { run, query, create } = await withActors(["physical"], ["service"]);
    const type = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    await create("item", { display_name: { en: "Bolt" }, type });

    await expect(
      run("scflow/create_flow", { source: "Source", destination: "Target", item: "Bolt" }),
    ).rejects.toThrow(/item.*physical.*destination/);

    expect(await query("flow")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);
  });

  it("requires an item between an actor and its child, in both directions", async () => {
    const { run, query } = await setup().then(async (ctx) => {
      await ctx.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
      await ctx.run("scflow/create_actor", { display_name: "Plant", type: "Site" });
      await ctx.run("scflow/create_actor", { display_name: "Workshop", type: "Site", parent_actor: "Plant" });
      const type = await ctx.create("item_type", { display_name: { en: "Part" }, domain: "physical" });
      await ctx.create("item", { display_name: { en: "Bolt" }, type });
      return ctx;
    });

    await expect(run("scflow/create_flow", { source: "Plant", destination: "Workshop" })).rejects.toThrow(/item/);
    await expect(run("scflow/create_flow", { source: "Workshop", destination: "Plant" })).rejects.toThrow(/item/);
    expect(await query("flow")).toHaveLength(0);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Plant",
      destination: "Workshop",
      item: "Bolt",
    });

    expect(flow).toHaveProperty("item");
    expect(await query("flow")).toHaveLength(1);
    expect(await query("item_at_actor")).toHaveLength(2);
  });

  it("creates a bidirectional flow when asked, a one-way flow otherwise", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);

    const plain = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
    });
    const both = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
      bidirectional: true,
    });

    expect(plain.bidirectional).toBe(false);
    expect(both.bidirectional).toBe(true);
    expect((await query("flow", { id: both.id }))[0].bidirectional).toBe(true);
  });

  it("refuses a bidirectional parameter that is not a boolean and creates nothing", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);

    await expect(
      run("scflow/create_flow", { source: "Source", destination: "Target", bidirectional: "yes" }),
    ).rejects.toThrow(/bidirectional/);
    expect(await query("flow")).toHaveLength(0);
  });

  it("gives its name to the flow, and no name when omitted", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);

    const unnamed = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
    });
    const named = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
      display_name: { en: "Lane", fr: "Voie" },
    });

    expect(unnamed).not.toHaveProperty("display_name");
    expect(named.display_name).toEqual({ en: "Lane", fr: "Voie" });
    expect((await query("flow", { id: named.id }))[0].display_name).toEqual({ en: "Lane", fr: "Voie" });
  });

  it("stores a plain string name as English", async () => {
    const { run } = await withActors(["physical"], ["physical"]);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
      display_name: "Lane",
    });

    expect(flow.display_name).toEqual({ en: "Lane" });
  });

  it("refuses a name that is neither a string nor a map and creates nothing", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);

    await expect(
      run("scflow/create_flow", { source: "Source", destination: "Target", display_name: 42 }),
    ).rejects.toThrow(/name/);
    expect(await query("flow")).toHaveLength(0);
  });

  it("stores the description and the tags", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);

    const flow = await run<Record<string, unknown>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
      description: "Weekly lane",
      tags: ["express", "express", "road"],
    });

    const stored = (await query("flow", { id: flow.id }))[0];
    expect(stored.description).toEqual({ en: "Weekly lane" });
    expect(stored.tags).toEqual(["express", "road"]);
  });

  it("creates a new flow at each call, without reusing the existing ones", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);

    await run("scflow/create_flow", { source: "Source", destination: "Target" });
    await run("scflow/create_flow", { source: "Source", destination: "Target" });

    expect(await query("flow")).toHaveLength(2);
  });

  it("refuses an unknown or missing actor, naming the parameter", async () => {
    const { run } = await withActors(["physical"], ["physical"]);

    await expect(run("scflow/create_flow", { source: "Ghost", destination: "Target" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/create_flow", { source: "Source", destination: "Ghost" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/create_flow", { source: "Source" })).rejects.toThrow(/destination/);
  });
});

describe("scflow/update_flow", () => {
  /** Two connected actors; returns the only flow between them. */
  async function withFlow() {
    const ctx = await withActors(["physical"], ["physical"]);
    const flow = await ctx.run<Record<string, any>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
    });
    return { ...ctx, flow };
  }

  it("is declared in the catalog", () => {
    expect(ACTIONS.map((action) => action.id)).toContain("scflow/update_flow");
  });

  it("makes a flow bidirectional and one-way again, and returns it", async () => {
    const { run, query, flow, source, target } = await withFlow();

    const both = await run("scflow/update_flow", { id: flow.id, bidirectional: true });

    expect(both).toEqual({
      id: flow.id,
      source: source.id,
      destination: target.id,
      bidirectional: true,
    });
    expect((await query("flow", { id: flow.id }))[0].bidirectional).toBe(true);

    const oneWay = await run<Record<string, unknown>>("scflow/update_flow", { id: flow.id, bidirectional: false });
    expect(oneWay.bidirectional).toBe(false);
    expect((await query("flow", { id: flow.id }))[0].bidirectional).toBe(false);
  });

  it("changes the description and the tags", async () => {
    const { run, query, flow } = await withFlow();

    await run("scflow/update_flow", { id: flow.id, description: "Weekly lane", tags: ["a", "b"] });

    const stored = (await query("flow", { id: flow.id }))[0];
    expect(stored.description).toEqual({ en: "Weekly lane" });
    expect(stored.tags).toEqual(["a", "b"]);
  });

  it("sets the name, merges languages and removes the name with null", async () => {
    const { run, query, flow } = await withFlow();

    const named = await run<Record<string, unknown>>("scflow/update_flow", { id: flow.id, display_name: "Lane" });
    expect(named.display_name).toEqual({ en: "Lane" });

    const merged = await run<Record<string, unknown>>("scflow/update_flow", { id: flow.id, display_name: { fr: "Voie" } });
    expect(merged.display_name).toEqual({ en: "Lane", fr: "Voie" });
    expect((await query("flow", { id: flow.id }))[0].display_name).toEqual({ en: "Lane", fr: "Voie" });

    const cleared = await run<Record<string, unknown>>("scflow/update_flow", { id: flow.id, display_name: null });
    expect(cleared).not.toHaveProperty("display_name");
    expect((await query("flow", { id: flow.id }))[0].display_name ?? {}).toEqual({});
  });

  it("refuses a name that is neither a string, a map nor null", async () => {
    const { run, flow } = await withFlow();

    await expect(run("scflow/update_flow", { id: flow.id, display_name: 42 })).rejects.toThrow(/name/);
  });

  it("leaves untouched what is not given", async () => {
    const { run, query, flow, source, target } = await withFlow();
    await run("scflow/update_flow", { id: flow.id, bidirectional: true, tags: ["x"] });

    await run("scflow/update_flow", { id: flow.id, description: "Lane" });

    const stored = (await query("flow", { id: flow.id }))[0];
    expect(stored).toMatchObject({ bidirectional: true, tags: ["x"], source: source.id, destination: target.id });
  });

  it("refuses a call that gives no property to change", async () => {
    const { run, flow } = await withFlow();

    await expect(run("scflow/update_flow", { id: flow.id })).rejects.toThrow(/must NOT have fewer/);
  });

  it("refuses an unknown or missing flow and a bidirectional that is not a boolean", async () => {
    const { run, query, flow } = await withFlow();

    await expect(run("scflow/update_flow", { id: "missing", bidirectional: true })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/update_flow", { bidirectional: true })).rejects.toThrow(/flow/);
    await expect(run("scflow/update_flow", { id: flow.id, bidirectional: "yes" })).rejects.toThrow(
      /bidirectional/,
    );
    expect((await query("flow", { id: flow.id }))[0].bidirectional).toBe(false);
  });
});

describe("scflow/delete_flow", () => {
  it("deletes the flow, and keeps its item, the items held by its ends and the actors", async () => {
    const { run, query, create, source, target } = await withActors(["physical"], ["physical"]);
    const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    const item = await create("item", { display_name: { en: "Bolt" }, type: itemType });
    const flow = await run<Record<string, any>>("scflow/create_flow", {
      source: "Source",
      destination: "Target",
      item: "Bolt",
    });

    const result = await run("scflow/delete_flow", { id: flow.id });

    expect(result).toEqual({ id: flow.id });
    expect(await query("flow")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(2);
    expect(await query("item", { id: item })).toHaveLength(1);
    expect(await query("actor", { id: source.id })).toHaveLength(1);
    expect(await query("actor", { id: target.id })).toHaveLength(1);
  });

  it("deletes only the given flow", async () => {
    const { run, query } = await withActors(["physical"], ["physical"]);
    const first = await run<Record<string, any>>("scflow/create_flow", { source: "Source", destination: "Target" });
    const second = await run<Record<string, any>>("scflow/create_flow", { source: "Source", destination: "Target" });

    await run("scflow/delete_flow", { id: first.id });

    const left = await query("flow");
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(second.id);
  });

  it("refuses an unknown or missing flow", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_flow", { id: "missing" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/delete_flow", {})).rejects.toThrow(/flow/);
  });
});

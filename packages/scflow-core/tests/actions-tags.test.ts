import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

/** Creates two actors, a flow between them, an item, a scope and the types, each actor and the item with its own tags. */
async function withEntities() {
  const ctx = await setup();
  await ctx.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
  await ctx.run("scflow/create_item_type", { display_name: "Part", domain: "physical" });
  const actor = await ctx.run("scflow/create_actor", { display_name: "Plant", type: "Site", tags: ["north", "key"] });
  await ctx.run("scflow/create_actor", { display_name: "Depot", type: "Site" });
  const item = await ctx.run("scflow/create_item", { display_name: "Bolt", type: "Part", tags: ["steel"] });
  const scope = await ctx.run("scflow/create_scope", { display_name: "North" });
  const flow = await ctx.run<Record<string, any>>("scflow/create_flow", {
    source: "Plant",
    destination: "Depot",
  });
  const actorType = (await ctx.query("actor_type"))[0];
  const itemType = (await ctx.query("item_type"))[0];
  return { ...ctx, actor, item, flow, scope, actorType, itemType };
}

describe("tag actions", () => {
  it("are declared with scoped unique ids, as mutations", () => {
    const tags = ACTIONS.filter((action) => /^scflow\/(add|remove)_tags$/.test(action.id));

    expect(tags.map((action) => action.id).sort()).toEqual(["scflow/add_tags", "scflow/remove_tags"]);
    expect(tags.every((action) => action.kind !== "read")).toBe(true);
    expect(new Set(ACTIONS.map((action) => action.id)).size).toBe(ACTIONS.length);
  });
});

describe("scflow/add_tags", () => {
  it("appends to the existing tags of an actor given by id", async () => {
    const { run, query, actor } = await withEntities();

    const result = await run("scflow/add_tags", { entity: actor.id, tags: ["dock", "eu"] });

    expect(result).toEqual({ id: actor.id, tags: ["north", "key", "dock", "eu"] });
    expect((await query("actor", { id: actor.id }))[0].tags).toEqual(["north", "key", "dock", "eu"]);
  });

  it("tags an item and a flow given by id", async () => {
    const { run, query, item, flow } = await withEntities();

    const onItem = await run("scflow/add_tags", { entity: item.id, tags: ["small"] });
    const onFlow = await run("scflow/add_tags", { entity: flow.id, tags: ["express"] });

    expect(onItem).toEqual({ id: item.id, tags: ["steel", "small"] });
    expect(onFlow).toEqual({ id: flow.id, tags: ["express"] });
    expect((await query("flow", { id: flow.id }))[0].tags).toEqual(["express"]);
  });

  it("tags a scope and the types, which carry no tag at creation", async () => {
    const { run, query, scope, actorType, itemType } = await withEntities();

    expect(await run("scflow/add_tags", { entity: scope.id, tags: ["region"] })).toEqual({ id: scope.id, tags: ["region"] });
    expect(await run("scflow/add_tags", { entity: actorType.id, tags: ["site"] })).toEqual({
      id: actorType.id,
      tags: ["site"],
    });
    expect(await run("scflow/add_tags", { entity: itemType.id, tags: ["part"] })).toEqual({
      id: itemType.id,
      tags: ["part"],
    });
    expect((await query("scope", { id: scope.id }))[0].tags).toEqual(["region"]);
    expect((await query("actor_type", { id: actorType.id }))[0].tags).toEqual(["site"]);
  });

  it("skips the tags already carried and the duplicates of the list", async () => {
    const { run, query, actor } = await withEntities();

    const result = await run("scflow/add_tags", { entity: actor.id, tags: ["key", "new", "new"] });

    expect(result.tags).toEqual(["north", "key", "new"]);
    expect((await query("actor", { id: actor.id }))[0].tags).toEqual(["north", "key", "new"]);
  });

  it("does nothing when every tag is already carried", async () => {
    const { run, actor } = await withEntities();

    const result = await run("scflow/add_tags", { entity: actor.id, tags: ["north"] });

    expect(result).toEqual({ id: actor.id, tags: ["north", "key"] });
  });

  it("refuses an unknown id and a missing or empty entity", async () => {
    const { run } = await withEntities();

    await expect(run("scflow/add_tags", { entity: "Ghost", tags: ["x"] })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/add_tags", { tags: ["x"] })).rejects.toThrow(/entity/);
    await expect(run("scflow/add_tags", { entity: "", tags: ["x"] })).rejects.toThrow(/names no instance/);
  });

  it("refuses a missing, empty or malformed list of tags and changes nothing", async () => {
    const { run, query, actor } = await withEntities();

    await expect(run("scflow/add_tags", { entity: actor.id })).rejects.toThrow(/tags/);
    await expect(run("scflow/add_tags", { entity: actor.id, tags: [] })).rejects.toThrow(/tags/);
    await expect(run("scflow/add_tags", { entity: actor.id, tags: [""] })).rejects.toThrow(/tags/);
    await expect(run("scflow/add_tags", { entity: actor.id, tags: "x" })).rejects.toThrow(/tags/);
    expect((await query("actor", { id: actor.id }))[0].tags).toEqual(["north", "key"]);
  });
});

describe("scflow/remove_tags", () => {
  it("removes the given tags and keeps the others in order", async () => {
    const { run, query, actor } = await withEntities();
    await run("scflow/add_tags", { entity: actor.id, tags: ["dock"] });

    const result = await run("scflow/remove_tags", { entity: actor.id, tags: ["key"] });

    expect(result).toEqual({ id: actor.id, tags: ["north", "dock"] });
    expect((await query("actor", { id: actor.id }))[0].tags).toEqual(["north", "dock"]);
  });

  it("ignores a tag that is not carried", async () => {
    const { run, item } = await withEntities();

    const result = await run("scflow/remove_tags", { entity: item.id, tags: ["absent", "steel"] });

    expect(result).toEqual({ id: item.id, tags: [] });
  });

  it("works on a flow and on a scope given by id", async () => {
    const { run, flow, scope } = await withEntities();
    await run("scflow/add_tags", { entity: flow.id, tags: ["a", "b"] });
    await run("scflow/add_tags", { entity: scope.id, tags: ["c", "d"] });

    expect(await run("scflow/remove_tags", { entity: flow.id, tags: ["a"] })).toEqual({ id: flow.id, tags: ["b"] });
    expect(await run("scflow/remove_tags", { entity: scope.id, tags: ["d"] })).toEqual({ id: scope.id, tags: ["c"] });
  });

  it("refuses an unknown id and an empty list of tags", async () => {
    const { run, query, actor } = await withEntities();

    await expect(run("scflow/remove_tags", { entity: "Ghost", tags: ["x"] })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/remove_tags", { entity: actor.id, tags: [] })).rejects.toThrow(/tags/);
    await expect(run("scflow/remove_tags", { entity: actor.id })).rejects.toThrow(/tags/);
    expect((await query("actor", { id: actor.id }))[0].tags).toEqual(["north", "key"]);
  });
});

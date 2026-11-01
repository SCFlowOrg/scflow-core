import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

describe("ACTIONS", () => {
  it("declares the lot 1 actions with scoped unique ids and object parameters", async () => {
    const ids = ACTIONS.map((action) => action.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "scflow/create_scope",
      "scflow/create_actor_type",
      "scflow/create_actor",
      "scflow/update_actor",
      "scflow/delete_actor",
      "scflow/delete_actor_type",
      "scflow/delete_scope",
    ]) {
      expect(ids).toContain(id);
    }
    for (const action of ACTIONS) {
      expect(action.id).toMatch(/^scflow\/[a-z_]+$/);
      expect(action.title.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
      expect(action.parameters.type).toBe("object");
      for (const required of action.parameters.required ?? []) {
        expect(Object.keys(action.parameters.properties)).toContain(required);
      }
    }
  });
});

describe("scflow/create_scope", () => {
  it("creates a scope from a plain name and returns it", async () => {
    const { run, query } = await setup();

    const scope = await run("scflow/create_scope", { name: "Make", description: "Production lane" });

    expect(scope).toMatchObject({ display_name: { en: "Make" } });
    const stored = await query("scope");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: scope.id, description: { en: "Production lane" } });
  });

  it("keeps a localized name", async () => {
    const { run } = await setup();

    const scope = await run("scflow/create_scope", { name: { en: "Make", fr: "Fabriquer" } });

    expect(scope.display_name).toEqual({ en: "Make", fr: "Fabriquer" });
  });

  it("refuses a missing name and writes nothing", async () => {
    const { run, query } = await setup();

    await expect(run("scflow/create_scope", {})).rejects.toThrow(/name/);

    expect(await query("scope")).toHaveLength(0);
  });
});

describe("scflow/create_actor_type", () => {
  it("defaults the domains to physical", async () => {
    const { run } = await setup();

    const type = await run("scflow/create_actor_type", { name: "Warehouse" });

    expect(type).toMatchObject({ display_name: { en: "Warehouse" }, domains: ["physical"] });
  });

  it("takes the given domains and a default scope given by name", async () => {
    const { run, create } = await setup();
    const deliver = await create("scope", { display_name: { en: "Deliver" } });

    const type = await run("scflow/create_actor_type", {
      name: "Carrier",
      domains: ["physical", "information"],
      default_scope: "Deliver",
    });

    expect(type.domains).toEqual(expect.arrayContaining(["physical", "information"]));
    expect(type.default_scope).toBe(deliver);
  });

  it("refuses an unknown domain and writes nothing", async () => {
    const { run, query } = await setup();

    await expect(run("scflow/create_actor_type", { name: "Odd", domains: ["magic"] })).rejects.toThrow(/domains/);

    expect(await query("actor_type")).toHaveLength(0);
  });

  it("refuses an empty list of domains", async () => {
    const { run } = await setup();

    await expect(run("scflow/create_actor_type", { name: "Odd", domains: [] })).rejects.toThrow(/domains/);
  });

  it("refuses an unknown default scope and writes nothing", async () => {
    const { run, query } = await setup();

    await expect(run("scflow/create_actor_type", { name: "Odd", default_scope: "Ghost" })).rejects.toThrow(
      /default_scope/,
    );

    expect(await query("actor_type")).toHaveLength(0);
  });
});

describe("scflow/create_actor", () => {
  it("creates an actor whose type is given by name", async () => {
    const { run, create } = await setup();
    const type = await create("actor_type", { display_name: { en: "Warehouse" }, domains: ["physical"] });

    const actor = await run("scflow/create_actor", { name: "Main warehouse", type: "Warehouse" });

    expect(actor).toMatchObject({ display_name: { en: "Main warehouse" }, type });
    expect(typeof actor.id).toBe("string");
  });

  it("inherits the default scope of its type and accepts a scope given by name", async () => {
    const { run, create } = await setup();
    const deliver = await create("scope", { display_name: { en: "Deliver" } });
    const make = await create("scope", { display_name: { en: "Make" } });
    await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"], default_scope: deliver });

    const inherited = await run("scflow/create_actor", { name: "A", type: "Site" });
    const explicit = await run("scflow/create_actor", { name: "B", type: "Site", scope: "Make" });

    expect(inherited.scope).toBe(deliver);
    expect(explicit.scope).toBe(make);
  });

  it("sets the parent actor given by name, the description and the tags", async () => {
    const { run, create, query } = await setup();
    await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    const parent = await run("scflow/create_actor", { name: "Campus", type: "Site" });

    const child = await run("scflow/create_actor", {
      name: "Dock",
      type: "Site",
      parent_actor: "Campus",
      description: "Loading dock",
      tags: ["north", "dock"],
    });

    expect(child.parent_actor).toBe(parent.id);
    const stored = (await query("actor", { id: child.id }))[0];
    expect(stored.description).toEqual({ en: "Loading dock" });
    expect(stored.tags).toEqual(["north", "dock"]);
  });

  it("places the actor at a location given by name, and at none by default", async () => {
    const { run, create, query } = await setup();
    await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    const havre = await create("location", { display_name: { en: "Le Havre" } });

    const placed = await run("scflow/create_actor", { name: "Terminal", type: "Site", location: "Le Havre" });
    const bare = await run("scflow/create_actor", { name: "Depot", type: "Site" });

    expect(placed.location).toBe(havre);
    expect(bare).not.toHaveProperty("location");
    expect((await query("actor", { id: placed.id }))[0].location).toBe(havre);
  });

  it("lets several actors share a location", async () => {
    const { run, create, query } = await setup();
    await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    const havre = await create("location", { display_name: { en: "Le Havre" } });

    const a = await run("scflow/create_actor", { name: "A", type: "Site", location: havre });
    const b = await run("scflow/create_actor", { name: "B", type: "Site", location: "Le Havre" });

    expect((await query("location", { id: havre }))[0].actors.sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses an unknown type, scope, location or parent and writes nothing", async () => {
    const { run, create, query } = await setup();
    await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });

    await expect(run("scflow/create_actor", { name: "X", type: "Ghost" })).rejects.toThrow(/type/);
    await expect(run("scflow/create_actor", { name: "X", type: "Site", scope: "Ghost" })).rejects.toThrow(/scope/);
    await expect(run("scflow/create_actor", { name: "X", type: "Site", location: "Ghost" })).rejects.toThrow(
      /location/,
    );
    await expect(run("scflow/create_actor", { name: "X", type: "Site", parent_actor: "Ghost" })).rejects.toThrow(
      /parent_actor/,
    );

    expect(await query("actor")).toHaveLength(0);
  });

  it("refuses a missing name or type", async () => {
    const { run } = await setup();

    await expect(run("scflow/create_actor", { type: "Site" })).rejects.toThrow(/name/);
    await expect(run("scflow/create_actor", { name: "X" })).rejects.toThrow(/type/);
  });
});

describe("scflow/update_actor", () => {
  async function withActors() {
    const ctx = await setup();
    await ctx.create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    await ctx.create("scope", { display_name: { en: "Make" } });
    const campus = await ctx.run("scflow/create_actor", { name: "Campus", type: "Site" });
    const dock = await ctx.run("scflow/create_actor", {
      name: "Dock",
      type: "Site",
      scope: "Make",
      parent_actor: "Campus",
    });
    return { ...ctx, campus, dock };
  }

  it("renames an actor given by name and keeps the other languages", async () => {
    const { run, query, dock } = await withActors();
    await run("scflow/update_actor", { actor: "Dock", name: { fr: "Quai" } });

    const updated = await run("scflow/update_actor", { actor: "Dock", name: "Loading dock" });

    expect(updated.display_name).toEqual({ en: "Loading dock", fr: "Quai" });
    expect((await query("actor", { id: dock.id }))[0].display_name).toEqual({ en: "Loading dock", fr: "Quai" });
  });

  it("changes the type of an actor given by name, and refuses an unknown type", async () => {
    const { run, create, query, dock } = await withActors();
    const warehouse = await create("actor_type", { display_name: { en: "Warehouse" }, domains: ["physical"] });

    const updated = await run("scflow/update_actor", { actor: "Dock", type: "Warehouse" });

    expect(updated.type).toBe(warehouse);
    expect((await query("actor", { id: dock.id }))[0].type).toBe(warehouse);
    await expect(run("scflow/update_actor", { actor: "Dock", type: "Ghost" })).rejects.toThrow(/type/);
    expect((await query("actor", { id: dock.id }))[0].type).toBe(warehouse);
  });

  it("changes the description and the tags", async () => {
    const { run, query, dock } = await withActors();

    await run("scflow/update_actor", { actor: dock.id, description: "Where trucks load", tags: ["a", "b"] });

    const stored = (await query("actor", { id: dock.id }))[0];
    expect(stored.description).toEqual({ en: "Where trucks load" });
    expect(stored.tags).toEqual(["a", "b"]);
  });

  it("detaches the scope and moves the actor to the root with null", async () => {
    const { run, query, dock } = await withActors();

    await run("scflow/update_actor", { actor: "Dock", scope: null, parent_actor: null });

    const stored = (await query("actor", { id: dock.id }))[0];
    expect(stored.scope ?? null).toBeNull();
    expect(stored.parent_actor ?? null).toBeNull();
  });

  it("changes the scope and the parent given by name", async () => {
    const { run, create, query, campus, dock } = await withActors();
    const deliver = await create("scope", { display_name: { en: "Deliver" } });
    const annex = await run("scflow/create_actor", { name: "Annex", type: "Site" });

    await run("scflow/update_actor", { actor: "Dock", scope: "Deliver", parent_actor: "Annex" });

    const stored = (await query("actor", { id: dock.id }))[0];
    expect(stored.scope).toBe(deliver);
    expect(stored.parent_actor).toBe(annex.id);
    expect(stored.parent_actor).not.toBe(campus.id);
  });

  it("sets, changes and clears the location of an actor, given by name or id", async () => {
    const { run, create, query, dock } = await withActors();
    const havre = await create("location", { display_name: { en: "Le Havre" } });
    const rotterdam = await create("location", { display_name: { en: "Rotterdam" } });

    const placed = await run("scflow/update_actor", { actor: "Dock", location: "Le Havre" });
    expect(placed.location).toBe(havre);

    const moved = await run("scflow/update_actor", { actor: "Dock", location: rotterdam });
    expect(moved.location).toBe(rotterdam);
    expect((await query("actor", { id: dock.id }))[0].location).toBe(rotterdam);
    expect((await query("location", { id: havre }))[0].actors).toEqual([]);

    const cleared = await run("scflow/update_actor", { actor: "Dock", location: null });
    expect(cleared).not.toHaveProperty("location");
    expect((await query("actor", { id: dock.id }))[0].location ?? null).toBeNull();
  });

  it("refuses an unknown location and keeps the current one", async () => {
    const { run, create, query, dock } = await withActors();
    const havre = await create("location", { display_name: { en: "Le Havre" } });
    await run("scflow/update_actor", { actor: "Dock", location: "Le Havre" });

    await expect(run("scflow/update_actor", { actor: "Dock", location: "Ghost" })).rejects.toThrow(/location/);

    expect((await query("actor", { id: dock.id }))[0].location).toBe(havre);
  });

  it("leaves untouched what is not given", async () => {
    const { run, query, dock, campus } = await withActors();

    await run("scflow/update_actor", { actor: "Dock", tags: ["x"] });

    const stored = (await query("actor", { id: dock.id }))[0];
    expect(stored.parent_actor).toBe(campus.id);
    expect(stored.display_name).toEqual({ en: "Dock" });
  });

  it("refuses an actor as its own parent, directly or through its descendants", async () => {
    const { run } = await withActors();

    await expect(run("scflow/update_actor", { actor: "Dock", parent_actor: "Dock" })).rejects.toThrow(/parent_actor/);
    await expect(run("scflow/update_actor", { actor: "Campus", parent_actor: "Dock" })).rejects.toThrow(
      /parent_actor/,
    );
  });

  it("refuses a call that gives no property to change", async () => {
    const { run } = await withActors();

    await expect(run("scflow/update_actor", { actor: "Dock" })).rejects.toThrow(/at least one/);
  });

  it("refuses an unknown actor, scope or parent and changes nothing", async () => {
    const { run, query, dock } = await withActors();

    await expect(run("scflow/update_actor", { actor: "Ghost", name: "X" })).rejects.toThrow(/actor/);
    await expect(run("scflow/update_actor", { actor: "Dock", name: "X", scope: "Ghost" })).rejects.toThrow(/scope/);

    expect((await query("actor", { id: dock.id }))[0].display_name).toEqual({ en: "Dock" });
  });
});

describe("scflow/delete_actor", () => {
  async function withNetwork() {
    const ctx = await setup();
    const { create, run } = ctx;
    await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    const a = await run("scflow/create_actor", { name: "A", type: "Site" });
    const b = await run("scflow/create_actor", { name: "B", type: "Site" });
    const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    const item = await create("item", { display_name: { en: "Bolt" }, type: itemType });
    const flow = await create("flow", { source: a.id, destination: b.id });
    const held = await create("item_at_actor", { actor: a.id, item });
    const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
    const transformation = await create("transformation", {
      display_name: { en: "Assemble" },
      type: transformationType,
      actor: a.id,
    });
    await create("transformation_line", { transformation, role: "consumed", held_item: held });
    return { ...ctx, a, b, item, flow, held, transformation };
  }

  it("deletes an actor given by name that nothing references", async () => {
    const { run, query } = await setup();
    await run("scflow/create_actor_type", { name: "Site" });
    await run("scflow/create_actor", { name: "Lonely", type: "Site" });

    const result = await run("scflow/delete_actor", { actor: "Lonely" });

    expect(typeof result.id).toBe("string");
    expect(await query("actor")).toHaveLength(0);
  });

  it("refuses to delete an actor with an incident flow, and removes nothing", async () => {
    const { run, query } = await withNetwork();

    await expect(run("scflow/delete_actor", { actor: "B" })).rejects.toThrow(/flow/);

    expect(await query("actor")).toHaveLength(2);
    expect(await query("flow")).toHaveLength(1);
  });

  it("refuses to delete an actor that holds an item, and removes nothing", async () => {
    const { run, query, create } = await setup();
    await run("scflow/create_actor_type", { name: "Site" });
    const actor = await run("scflow/create_actor", { name: "Depot", type: "Site" });
    const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    const item = await create("item", { display_name: { en: "Bolt" }, type: itemType });
    await create("item_at_actor", { actor: actor.id, item });

    await expect(run("scflow/delete_actor", { actor: "Depot" })).rejects.toThrow(/held item/);

    expect(await query("actor")).toHaveLength(1);
    expect(await query("item_at_actor")).toHaveLength(1);
  });

  it("refuses to delete an actor that runs a transformation, and removes nothing", async () => {
    const { run, query, create } = await setup();
    await run("scflow/create_actor_type", { name: "Site" });
    const actor = await run("scflow/create_actor", { name: "Plant", type: "Site" });
    const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
    await create("transformation", { display_name: { en: "Assemble" }, type: transformationType, actor: actor.id });

    await expect(run("scflow/delete_actor", { actor: "Plant" })).rejects.toThrow(/transformation/);

    expect(await query("actor")).toHaveLength(1);
    expect(await query("transformation")).toHaveLength(1);
  });

  it("removes incident flows, held items and transformations with cascade, and nothing else", async () => {
    const { run, query, a, b, item } = await withNetwork();

    await run("scflow/delete_actor", { actor: "A", cascade: true });

    expect(await query("actor", { id: a.id })).toHaveLength(0);
    expect(await query("flow")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);
    expect(await query("transformation")).toHaveLength(0);
    expect(await query("transformation_line")).toHaveLength(0);
    expect(await query("actor", { id: b.id })).toHaveLength(1);
    expect(await query("item", { id: item })).toHaveLength(1);
  });

  it("refuses to delete a parent actor without cascade, and removes nothing", async () => {
    const { run, query } = await setup();
    await run("scflow/create_actor_type", { name: "Site" });
    await run("scflow/create_actor", { name: "Campus", type: "Site" });
    await run("scflow/create_actor", { name: "Dock", type: "Site", parent_actor: "Campus" });

    await expect(run("scflow/delete_actor", { actor: "Campus" })).rejects.toThrow(/child/);

    expect(await query("actor")).toHaveLength(2);
  });

  describe("with cascade on a tree of actors", () => {
    async function withTree() {
      const ctx = await setup();
      const { create, run } = ctx;
      await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
      const campus = await run("scflow/create_actor", { name: "Campus", type: "Site" });
      const dock = await run("scflow/create_actor", { name: "Dock", type: "Site", parent_actor: "Campus" });
      const bay = await run("scflow/create_actor", { name: "Bay", type: "Site", parent_actor: "Dock" });
      const outside = await run("scflow/create_actor", { name: "Outside", type: "Site" });
      const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
      const item = await create("item", { display_name: { en: "Bolt" }, type: itemType });
      await create("flow", { source: outside.id, destination: bay.id, item });
      await create("flow", { source: dock.id, destination: outside.id });
      const flowOther = await create("flow", { source: outside.id, destination: outside.id });
      const heldDock = await create("item_at_actor", { actor: dock.id, item });
      const heldOutside = await create("item_at_actor", { actor: outside.id, item });
      const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
      const transformation = await create("transformation", {
        display_name: { en: "Assemble" },
        type: transformationType,
        actor: bay.id,
      });
      const heldBay = await create("item_at_actor", { actor: bay.id, item });
      await create("transformation_line", { transformation, role: "consumed", held_item: heldBay });
      await create("note", { annotated: bay.id, content: { en: "Bay note" } });
      await create("note", { annotated: heldDock, content: { en: "Held note" } });
      await create("note", { annotated: outside.id, content: { en: "Outside note" } });
      return { ...ctx, campus, dock, bay, outside, item, flowOther, heldOutside, transformationType };
    }

    it("deletes the descendants, their incident flows, held items, transformations and notes", async () => {
      const { run, query, campus, outside, item, flowOther, heldOutside, transformationType } = await withTree();

      await run("scflow/delete_actor", { actor: "Campus", cascade: true });

      expect((await query("actor")).map((actor) => actor.id)).toEqual([outside.id]);
      expect((await query("flow")).map((flow) => flow.id)).toEqual([flowOther]);
      expect((await query("item_at_actor")).map((held) => held.id)).toEqual([heldOutside]);
      expect(await query("transformation")).toHaveLength(0);
      expect(await query("transformation_line")).toHaveLength(0);
      expect((await query("note")).map((note) => note.content)).toEqual([{ en: "Outside note" }]);
      expect(await query("item", { id: item })).toHaveLength(1);
      expect(await query("transformation_type", { id: transformationType })).toHaveLength(1);
      expect(await query("actor", { id: campus.id })).toHaveLength(0);
    });

    it("deletes only the subtree of a middle actor", async () => {
      const { run, query, campus, dock } = await withTree();

      await run("scflow/delete_actor", { actor: "Dock", cascade: true });

      const remaining = (await query("actor")).map((actor) => actor.id);
      expect(remaining).toContain(campus.id);
      expect(remaining).not.toContain(dock.id);
      expect(await query("actor")).toHaveLength(2);
    });

    it("refuses a parent actor without cascade and removes nothing", async () => {
      const { run, query } = await withTree();

      await expect(run("scflow/delete_actor", { actor: "Campus" })).rejects.toThrow(/child/);

      expect(await query("actor")).toHaveLength(4);
      expect(await query("flow")).toHaveLength(3);
    });
  });

  it("refuses an unknown actor", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_actor", { actor: "Ghost" })).rejects.toThrow(/actor/);
  });
});

describe("scflow/delete_actor_type", () => {
  async function withTypes() {
    const ctx = await setup();
    const { create, run } = ctx;
    const site = await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    const carrier = await create("actor_type", { display_name: { en: "Carrier" }, domains: ["physical"] });
    const campus = await run("scflow/create_actor", { name: "Campus", type: "Site" });
    const dock = await run("scflow/create_actor", { name: "Dock", type: "Site", parent_actor: "Campus" });
    const truck = await run("scflow/create_actor", { name: "Truck", type: "Carrier" });
    await create("flow", { source: campus.id, destination: dock.id });
    const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical" });
    const item = await create("item", { display_name: { en: "Bolt" }, type: itemType });
    await create("item_at_actor", { actor: dock.id, item });
    await create("note", { annotated: dock.id, content: { en: "Dock note" } });
    return { ...ctx, site, carrier, campus, dock, truck };
  }

  it("deletes a type that no actor uses, given by name", async () => {
    const { run, query, create } = await setup();
    await create("actor_type", { display_name: { en: "Unused" }, domains: ["physical"] });

    const result = await run("scflow/delete_actor_type", { type: "Unused" });

    expect(typeof result.id).toBe("string");
    expect(await query("actor_type")).toHaveLength(0);
  });

  it("refuses a type that actors use without cascade, and removes nothing", async () => {
    const { run, query } = await withTypes();

    await expect(run("scflow/delete_actor_type", { type: "Site" })).rejects.toThrow(/actor/);

    expect(await query("actor_type")).toHaveLength(2);
    expect(await query("actor")).toHaveLength(3);
  });

  it("deletes the actors of the type with their full cascade, and the type", async () => {
    const { run, query, truck, carrier } = await withTypes();

    await run("scflow/delete_actor_type", { type: "Site", cascade: true });

    expect((await query("actor")).map((actor) => actor.id)).toEqual([truck.id]);
    expect((await query("actor_type")).map((type) => type.id)).toEqual([carrier]);
    expect(await query("flow")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);
    expect(await query("note")).toHaveLength(0);
  });

  it("refuses an unknown type", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_actor_type", { type: "Ghost" })).rejects.toThrow(/type/);
  });
});

describe("scflow/delete_scope", () => {
  async function withScopes() {
    const ctx = await setup();
    const { create, run } = ctx;
    const make = await create("scope", { display_name: { en: "Make" } });
    const deliver = await create("scope", { display_name: { en: "Deliver" } });
    const site = await create("actor_type", {
      display_name: { en: "Site" },
      domains: ["physical"],
      default_scope: make,
    });
    const plant = await run("scflow/create_actor", { name: "Plant", type: "Site", scope: "Make" });
    const line = await run("scflow/create_actor", { name: "Line", type: "Site", scope: "Make", parent_actor: "Plant" });
    const cell = await run("scflow/create_actor", { name: "Cell", type: "Site", scope: "Deliver", parent_actor: "Line" });
    const hub = await run("scflow/create_actor", { name: "Hub", type: "Site", scope: "Deliver" });
    await create("flow", { source: hub.id, destination: plant.id });
    await create("note", { annotated: line.id, content: { en: "Line note" } });
    return { ...ctx, make, deliver, site, plant, line, cell, hub };
  }

  it("deletes a scope that no actor uses, given by name", async () => {
    const { run, query, create } = await setup();
    await create("scope", { display_name: { en: "Empty" } });

    await run("scflow/delete_scope", { scope: "Empty" });

    expect(await query("scope")).toHaveLength(0);
  });

  it("refuses a scope that actors use without cascade, and removes nothing", async () => {
    const { run, query } = await withScopes();

    await expect(run("scflow/delete_scope", { scope: "Make" })).rejects.toThrow(/actor/);

    expect(await query("scope")).toHaveLength(2);
    expect(await query("actor")).toHaveLength(4);
  });

  it("deletes the actors of the scope with their descendants, flows and notes, and the scope", async () => {
    const { run, query, deliver, hub, site } = await withScopes();

    await run("scflow/delete_scope", { scope: "Make", cascade: true });

    expect((await query("actor")).map((actor) => actor.id)).toEqual([hub.id]);
    expect((await query("scope")).map((scope) => scope.id)).toEqual([deliver]);
    expect(await query("flow")).toHaveLength(0);
    expect(await query("note")).toHaveLength(0);
    const type = (await query("actor_type", { id: site }))[0];
    expect(type.default_scope ?? null).toBeNull();
  });

  it("refuses an unknown scope", async () => {
    const { run } = await setup();

    await expect(run("scflow/delete_scope", { scope: "Ghost" })).rejects.toThrow(/scope/);
  });
});

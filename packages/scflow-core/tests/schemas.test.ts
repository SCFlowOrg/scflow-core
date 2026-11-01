import { describe, expect, it } from "vitest";
import { createTestDocument } from "@scfloworg/core-plugin-core/testing";
import { SCHEMAS } from "../src/index.js";

async function setup() {
  return createTestDocument(SCHEMAS);
}

describe("SCFLOW schemas", () => {
  it("exports the scalar types and the schemas of the model", () => {
    expect(SCHEMAS.scalar_types.map((t) => t.name)).toEqual([
      "flow_domain",
      "transformation_role",
      "tag",
      "latitude",
      "longitude",
      "country_code",
      "un_locode",
    ]);
    expect(SCHEMAS.schemas.map((s) => s.name)).toEqual([
      "annotable",
      "note",
      "actor_type",
      "item_type",
      "actor",
      "flow",
      "item",
      "item_at_actor",
      "transformation_type",
      "transformation",
      "transformation_line",
      "conversion",
      "scope",
      "location",
    ]);
  });

  it("gives a flow one optional item, listed by the generated carried_on relation of the item", async () => {
    const { mcl, locator } = await setup();
    const type = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Site" }, domains: ["physical"] },
    });
    const itemType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: { display_name: { en: "Part" }, domain: "physical" },
    });
    const item = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item",
      input: { display_name: { en: "Bolt" }, type: itemType.after[0].id },
    });
    const a = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "A" }, type: type.after[0].id },
    });
    const b = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "B" }, type: type.after[0].id },
    });

    const without = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: a.after[0].id, destination: b.after[0].id },
    });
    const carrying = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: a.after[0].id, destination: b.after[0].id, item: item.after[0].id },
    });

    expect(without.after[0].item ?? null).toBeNull();
    expect(carrying.after[0].item).toBe(item.after[0].id);
    const stored = await mcl.runCommand(locator, { kind: "query", schema: "item", filters: { id: item.after[0].id } });
    expect(stored.after[0].carried_on).toEqual([carrying.after[0].id]);
  });

  it("keys no schema by name and gives none a name property", () => {
    for (const schema of SCHEMAS.schemas) {
      expect(schema.shared_by_name).toBeUndefined();
      expect((schema.properties ?? []).map((p) => p.name)).not.toContain("name");
    }
  });

  it("creates an actor_type with one or more domains and a generated id", async () => {
    const { mcl, locator } = await setup();
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Warehouse", fr: "Entrepôt" }, domains: ["physical", "information"] },
    });
    expect(after[0]).toMatchObject({
      display_name: { en: "Warehouse", fr: "Entrepôt" },
      domains: ["physical", "information"],
    });
    expect(typeof after[0].id).toBe("string");
    expect(after[0].id).not.toBe("");
  });

  it("refuses an actor_type without any domain", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor_type",
        input: { display_name: { en: "Warehouse" }, domains: [] },
      }),
    ).rejects.toThrow();
  });

  it("refuses an actor_type whose domains hold the same domain twice", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor_type",
        input: { display_name: { en: "Warehouse" }, domains: ["physical", "physical"] },
      }),
    ).rejects.toThrow();
  });

  it("stores the domains of an actor_type in the declaration order of flow_domain", async () => {
    const { mcl, locator } = await setup();
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Bank" }, domains: ["service", "information", "physical"] },
    });
    expect(after[0].domains).toEqual(["physical", "information", "service"]);
  });

  it("refuses an instance without any display_name language", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor_type",
        input: { display_name: {}, domains: ["physical"] },
      }),
    ).rejects.toThrow();
  });

  it("refuses an item_type domain outside the four flow domains", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "item_type",
        input: { display_name: { en: "Pallet" }, domain: "magic" },
      }),
    ).rejects.toThrow();
  });

  it("creates an item_type with one domain", async () => {
    const { mcl, locator } = await setup();
    const itemType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: { display_name: { en: "Pallet" }, domain: "physical" },
    });
    expect(itemType.after[0]).toMatchObject({ display_name: { en: "Pallet" }, domain: "physical" });
  });

  async function createActors(mcl: any, locator: any) {
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Site" }, domains: ["physical", "financial"] },
    });
    const actors = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: [
        { display_name: { en: "A" }, type: actorType.after[0].id },
        { display_name: { en: "B" }, type: actorType.after[0].id },
      ],
    });
    return { source: actors.after[0].id, destination: actors.after[1].id };
  }

  it("creates a flow with neither a domain nor a type", async () => {
    const { mcl, locator } = await setup();
    const { source, destination } = await createActors(mcl, locator);
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source, destination },
    });
    expect(after[0]).toMatchObject({ source, destination });
    expect(after[0]).not.toHaveProperty("domain");
    expect(after[0]).not.toHaveProperty("type");
  });

  it("declares no domain property on a flow", () => {
    const flow = SCHEMAS.schemas.find((s) => s.name === "flow") as { properties: { name: string }[] };
    expect(flow.properties.map((p) => p.name)).not.toContain("domain");
  });

  it("gives a flow a description and a display_name", () => {
    const flow = SCHEMAS.schemas.find((s) => s.name === "flow") as { properties: { name: string }[] };
    const names = flow.properties.map((p) => p.name);
    expect(names).toContain("description");
    expect(names).toContain("display_name");
  });

  it("refuses a flow without source or destination", async () => {
    const { mcl, locator } = await setup();
    const { source, destination } = await createActors(mcl, locator);
    await expect(
      mcl.runCommand(locator, { kind: "create", schema: "flow", input: { destination } }),
    ).rejects.toThrow();
    await expect(
      mcl.runCommand(locator, { kind: "create", schema: "flow", input: { source } }),
    ).rejects.toThrow();
  });

  it("changes the type of an actor and of an item", async () => {
    const { mcl, locator } = await setup();
    const types = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: [
        { display_name: { en: "Site" }, domains: ["physical"] },
        { display_name: { en: "Depot" }, domains: ["physical"] },
      ],
    });
    const actor = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "A" }, type: types.after[0].id },
    });
    const updatedActor = await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: actor.after[0].id },
      input: { type: types.after[1].id },
    });
    expect(updatedActor.after[0]).toMatchObject({ type: types.after[1].id });

    const itemTypes = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: [
        { display_name: { en: "Part" }, domain: "physical" },
        { display_name: { en: "Tool" }, domain: "physical" },
      ],
    });
    const item = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item",
      input: { display_name: { en: "Bolt" }, type: itemTypes.after[0].id },
    });
    const updatedItem = await mcl.runCommand(locator, {
      kind: "update",
      schema: "item",
      filters: { id: item.after[0].id },
      input: { type: itemTypes.after[1].id },
    });
    expect(updatedItem.after[0]).toMatchObject({ type: itemTypes.after[1].id });
  });

  it("adds a translation without touching the other languages", async () => {
    const { mcl, locator } = await setup();
    const created = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: { display_name: { en: "Pallet" }, description: { en: "A wooden pallet" }, domain: "physical" },
    });
    const id = created.after[0].id;
    const updated = await mcl.runCommand(locator, {
      kind: "update",
      schema: "item_type",
      filters: { id },
      input: { display_name: { set: { fr: "Palette" } } },
    });
    expect(updated.after[0].display_name).toEqual({ en: "Pallet", fr: "Palette" });
  });

  it("has no flow_network schema: the dataset is the network", () => {
    expect(SCHEMAS.schemas.map((s) => s.name)).not.toContain("flow_network");
  });

  it("keeps a scope flat, with a display_name and a description only", () => {
    const scope = SCHEMAS.schemas.find((s) => s.name === "scope") as { properties: { name: string }[] };
    expect(scope.properties.map((p) => p.name)).toEqual(["display_name", "description"]);
  });

  it("creates a scope with no owner", async () => {
    const { mcl, locator } = await setup();
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "scope",
      input: { display_name: { en: "Make" } },
    });
    expect(after[0]).toMatchObject({ display_name: { en: "Make" } });
    expect(typeof after[0].id).toBe("string");
  });

  it("refuses a scope without any display_name language", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "scope",
        input: { display_name: {} },
      }),
    ).rejects.toThrow();
  });

  it("creates an actor_type without a default_scope", async () => {
    const { mcl, locator } = await setup();
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Warehouse" }, domains: ["physical"] },
    });
    expect(after[0].default_scope ?? null).toBeNull();
  });

  it("gives an actor_type a default_scope", async () => {
    const { mcl, locator } = await setup();
    const scope = await mcl.runCommand(locator, {
      kind: "create",
      schema: "scope",
      input: { display_name: { en: "Deliver" } },
    });
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Warehouse" }, domains: ["physical"], default_scope: scope.after[0].id },
    });
    expect(after[0].default_scope).toBe(scope.after[0].id);
  });

  it("refuses a default_scope that is not an existing scope", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor_type",
        input: { display_name: { en: "Warehouse" }, domains: ["physical"], default_scope: "missing" },
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete an item that an actor holds, and deletes it once released", async () => {
    const { mcl, locator } = await setup();
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Warehouse" }, domains: ["physical"] },
    });
    const itemType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: { display_name: { en: "Pallet" }, domain: "physical" },
    });
    const actor = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "A" }, type: actorType.after[0].id },
    });
    const item = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item",
      input: { display_name: { en: "Pallet" }, type: itemType.after[0].id },
    });
    const held = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_at_actor",
      input: { actor: actor.after[0].id, item: item.after[0].id },
    });

    await expect(
      mcl.runCommand(locator, { kind: "delete", schema: "item", filters: { id: item.after[0].id } }),
    ).rejects.toMatchObject({ code: "constraint_violation" });
    expect((await mcl.runCommand(locator, { kind: "query", schema: "item" })).after).toHaveLength(1);

    await mcl.runCommand(locator, { kind: "delete", schema: "item_at_actor", filters: { id: held.after[0].id } });
    await mcl.runCommand(locator, { kind: "delete", schema: "item", filters: { id: item.after[0].id } });
    expect((await mcl.runCommand(locator, { kind: "query", schema: "item" })).after).toEqual([]);
  });

  it("deletes the items an actor holds with the actor", async () => {
    const { mcl, locator } = await setup();
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Warehouse" }, domains: ["physical"] },
    });
    const itemType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: { display_name: { en: "Pallet" }, domain: "physical" },
    });
    const actor = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "A" }, type: actorType.after[0].id },
    });
    const item = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item",
      input: { display_name: { en: "Pallet" }, type: itemType.after[0].id },
    });
    await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_at_actor",
      input: { actor: actor.after[0].id, item: item.after[0].id },
    });

    const deleted = await mcl.runCommand(locator, { kind: "delete", schema: "actor", filters: { id: actor.after[0].id } });
    expect(deleted["cascade-deleted"]).toHaveLength(1);
    expect((await mcl.runCommand(locator, { kind: "query", schema: "item_at_actor" })).after).toEqual([]);
    expect((await mcl.runCommand(locator, { kind: "query", schema: "item" })).after).toHaveLength(1);
  });

  it("places an actor in a scope", async () => {
    const { mcl, locator } = await setup();
    const scope = await mcl.runCommand(locator, {
      kind: "create",
      schema: "scope",
      input: { display_name: { en: "Source" } },
    });
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Supplier" }, domains: ["physical"] },
    });
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "A" }, type: actorType.after[0].id, scope: scope.after[0].id },
    });
    expect(after[0].scope).toBe(scope.after[0].id);
  });

  it("declares a location with only a mandatory display_name, and no relation to actors", () => {
    const location = SCHEMAS.schemas.find((s) => s.name === "location") as {
      is_root?: boolean;
      properties: { name: string; type: string; mandatory?: boolean }[];
    };
    expect(location.is_root).toBe(true);
    expect(location.properties.map((p) => [p.name, p.type])).toEqual([
      ["display_name", "localized_string"],
      ["description", "localized_markdown"],
      ["latitude", "latitude"],
      ["longitude", "longitude"],
      ["address", "string"],
      ["postal_code", "string"],
      ["city", "string"],
      ["country_code", "country_code"],
      ["un_locode", "un_locode"],
      ["timezone", "string"],
    ]);
    expect(location.properties.some((p) => p.mandatory)).toBe(false);
  });

  it("creates a location with every property", async () => {
    const { mcl, locator } = await setup();
    const input = {
      display_name: { en: "Port of Le Havre", fr: "Port du Havre" },
      description: { en: "Main seaport" },
      latitude: 49.4944,
      longitude: 0.1079,
      address: "Terminal de France",
      postal_code: "76600",
      city: "Le Havre",
      country_code: "FR",
      un_locode: "FRLEH",
      timezone: "Europe/Paris",
    };
    const { after } = await mcl.runCommand(locator, { kind: "create", schema: "location", input });
    expect(after[0]).toMatchObject(input);
    expect(after[0].tags).toEqual([]);
  });

  it("creates a location with a display_name alone: unset numbers are 0 and unset texts are empty", async () => {
    const { mcl, locator } = await setup();
    const created = await mcl.runCommand(locator, {
      kind: "create",
      schema: "location",
      input: { display_name: { en: "Plant site" } },
    });
    expect(created.after[0]).toMatchObject({
      latitude: 0,
      longitude: 0,
      address: "",
      postal_code: "",
      city: "",
      country_code: "",
      un_locode: "",
      timezone: "",
    });

    const geocoded = await mcl.runCommand(locator, {
      kind: "update",
      schema: "location",
      filters: { id: created.after[0].id },
      input: { latitude: 48.8566, longitude: 2.3522 },
    });
    expect(geocoded.after[0]).toMatchObject({ latitude: 48.8566, longitude: 2.3522 });
  });

  it("refuses a location without any display_name language", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, { kind: "create", schema: "location", input: { display_name: {} } }),
    ).rejects.toThrow();
  });

  it("refuses a latitude or a longitude out of range, and accepts the bounds", async () => {
    const { mcl, locator } = await setup();
    const create = (input: Record<string, unknown>) =>
      mcl.runCommand(locator, { kind: "create", schema: "location", input: { display_name: { en: "P" }, ...input } });
    await expect(create({ latitude: 90.1 })).rejects.toThrow();
    await expect(create({ latitude: -90.1 })).rejects.toThrow();
    await expect(create({ longitude: 180.1 })).rejects.toThrow();
    await expect(create({ longitude: -180.1 })).rejects.toThrow();
    const bounds = await create({ latitude: -90, longitude: 180 });
    expect(bounds.after[0]).toMatchObject({ latitude: -90, longitude: 180 });
  });

  it("refuses a country_code and a un_locode of the wrong format", async () => {
    const { mcl, locator } = await setup();
    const create = (input: Record<string, unknown>) =>
      mcl.runCommand(locator, { kind: "create", schema: "location", input: { display_name: { en: "P" }, ...input } });
    for (const country_code of ["fr", "FRA", "F", " FR"]) {
      await expect(create({ country_code })).rejects.toThrow();
    }
    for (const un_locode of ["frleh", "FRLE", "FRLEHX", "FR1EH", "FRL0H", "FRLEH "]) {
      await expect(create({ un_locode })).rejects.toThrow();
    }
    const valid = await create({ country_code: "DE", un_locode: "NLRTM" });
    expect(valid.after[0]).toMatchObject({ country_code: "DE", un_locode: "NLRTM" });
  });

  it("gives an actor no location by default", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "Plant" }, type },
    });
    expect(after[0].location ?? null).toBeNull();
  });

  it("places several actors at one location, lists them in actors, and lets the location change", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const locations = await mcl.runCommand(locator, {
      kind: "create",
      schema: "location",
      input: [{ display_name: { en: "Le Havre" } }, { display_name: { en: "Rotterdam" } }],
    });
    const [havre, rotterdam] = [locations.after[0].id, locations.after[1].id];
    const actors = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: [
        { display_name: { en: "Warehouse" }, type, location: havre },
        { display_name: { en: "Terminal" }, type, location: havre },
      ],
    });
    const [warehouse, terminal] = [actors.after[0].id, actors.after[1].id];
    expect(actors.after[0].location).toBe(havre);

    const stored = await mcl.runCommand(locator, { kind: "query", schema: "location", filters: { id: havre } });
    expect([...stored.after[0].actors].sort()).toEqual([warehouse, terminal].sort());

    const moved = await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: terminal },
      input: { location: rotterdam },
    });
    expect(moved.after[0].location).toBe(rotterdam);
    const afterMove = await mcl.runCommand(locator, { kind: "query", schema: "location", filters: { id: havre } });
    expect(afterMove.after[0].actors).toEqual([warehouse]);

    const cleared = await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: warehouse },
      input: { location: null },
    });
    expect(cleared.after[0].location ?? null).toBeNull();
  });

  it("refuses a location that is not an existing location", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor",
        input: { display_name: { en: "Plant" }, type, location: "missing" },
      }),
    ).rejects.toThrow();
  });

  it("clears the location of its actors when the location is deleted, and keeps the actors", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const location = (
      await mcl.runCommand(locator, { kind: "create", schema: "location", input: { display_name: { en: "Le Havre" } } })
    ).after[0].id;
    const actor = (
      await mcl.runCommand(locator, {
        kind: "create",
        schema: "actor",
        input: { display_name: { en: "Warehouse" }, type, location },
      })
    ).after[0].id;

    await mcl.runCommand(locator, { kind: "delete", schema: "location", filters: { id: location } });

    const stored = await mcl.runCommand(locator, { kind: "query", schema: "actor", filters: { id: actor } });
    expect(stored.after).toHaveLength(1);
    expect(stored.after[0].location ?? null).toBeNull();
  });

  it("declares actor.location as an optional, non-constant relation with the actors inverse", () => {
    const actor = SCHEMAS.schemas.find((s) => s.name === "actor") as {
      properties: {
        name: string;
        type: string;
        mandatory?: boolean;
        constant?: boolean;
        inverse_name?: string;
        inverse_is_array?: boolean;
      }[];
    };
    const location = actor.properties.find((p) => p.name === "location");
    expect(location).toMatchObject({ type: "location", inverse_name: "actors", inverse_is_array: true });
    expect(location?.mandatory).toBeUndefined();
    expect(location?.constant).toBeUndefined();
  });

  it("declares tags once, on annotable, as a unique array of tag", () => {
    const tag = SCHEMAS.scalar_types.find((t) => t.name === "tag") as { extends: string };
    expect(tag.extends).toBe("string");

    const annotable = SCHEMAS.schemas.find((s) => s.name === "annotable") as {
      properties: { name: string; type: string; is_array?: boolean; is_unique?: boolean; min_length?: number }[];
    };
    const tags = annotable.properties.find((p) => p.name === "tags");
    expect(tags).toMatchObject({ type: "tag", is_array: true, is_unique: true });
    expect(tags?.min_length).toBeUndefined();

    for (const schema of SCHEMAS.schemas.filter((s) => s.name !== "annotable")) {
      expect((schema.properties ?? []).map((p) => p.name)).not.toContain("tags");
    }
  });

  it("holds tags on an actor, a flow and an item, none by default", async () => {
    const { mcl, locator } = await setup();
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Site" }, domains: ["physical"] },
    });
    const itemType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item_type",
      input: { display_name: { en: "Pallet" }, domain: "physical" },
    });
    const bare = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "Bare" }, type: actorType.after[0].id },
    });
    expect(bare.after[0].tags).toEqual([]);

    const tagged = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "Tagged" }, type: actorType.after[0].id, tags: ["north", "key account"] },
    });
    expect(tagged.after[0].tags).toEqual(["north", "key account"]);

    const flow = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: bare.after[0].id, destination: tagged.after[0].id, tags: ["express"] },
    });
    expect(flow.after[0].tags).toEqual(["express"]);

    const item = await mcl.runCommand(locator, {
      kind: "create",
      schema: "item",
      input: { display_name: { en: "Pallet" }, type: itemType.after[0].id, tags: ["fragile"] },
    });
    expect(item.after[0].tags).toEqual(["fragile"]);

    const cleared = await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: tagged.after[0].id },
      input: { tags: [] },
    });
    expect(cleared.after[0].tags).toEqual([]);
  });

  it("holds tags on a scope and on every type, none by default", async () => {
    const { mcl, locator } = await setup();
    const create = async (schema: string, input: Record<string, unknown>) =>
      (await mcl.runCommand(locator, { kind: "create", schema, input })).after[0];

    const plain = await create("scope", { display_name: { en: "Plain" } });
    expect(plain.tags).toEqual([]);

    const scope = await create("scope", { display_name: { en: "North" }, tags: ["region"] });
    const actorType = await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"], tags: ["site"] });
    const itemType = await create("item_type", { display_name: { en: "Part" }, domain: "physical", tags: ["part"] });
    const transformationType = await create("transformation_type", { display_name: { en: "Assembly" }, tags: ["make"] });

    expect([scope.tags, actorType.tags, itemType.tags, transformationType.tags]).toEqual([
      ["region"],
      ["site"],
      ["part"],
      ["make"],
    ]);
  });

  it("declares bidirectional as a boolean on flow", () => {
    const schema = SCHEMAS.schemas.find((s) => s.name === "flow") as {
      properties: { name: string; type: string }[];
    };
    expect(schema.properties.find((p) => p.name === "bidirectional")).toMatchObject({ type: "boolean" });
  });

  it("declares display_name as an optional localized string on flow", () => {
    const schema = SCHEMAS.schemas.find((s) => s.name === "flow") as {
      properties: { name: string; type: string; mandatory?: boolean }[];
    };
    const property = schema.properties.find((p) => p.name === "display_name");
    expect(property).toMatchObject({ type: "localized_string" });
    expect(property?.mandatory).toBeFalsy();
  });

  it("holds a flow with no display_name and a flow with one", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const actors = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: [
        { display_name: { en: "A" }, type },
        { display_name: { en: "B" }, type },
      ],
    });
    const [a, b] = actors.after.map((actor) => actor.id);

    const plain = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: a, destination: b },
    });
    expect(plain.after[0].display_name ?? {}).toEqual({});

    const named = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: a, destination: b, display_name: { en: "Lane", fr: "Voie" } },
    });
    expect(named.after[0].display_name).toEqual({ en: "Lane", fr: "Voie" });
  });

  it("holds a flow that is not bidirectional by default and can be made bidirectional", async () => {
    const { mcl, locator } = await setup();
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Site" }, domains: ["physical"] },
    });
    const actors = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: [
        { display_name: { en: "A" }, type: actorType.after[0].id },
        { display_name: { en: "B" }, type: actorType.after[0].id },
      ],
    });
    const [a, b] = actors.after.map((actor) => actor.id);

    const plain = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: a, destination: b },
    });
    expect(plain.after[0].bidirectional).toBe(false);

    const both = await mcl.runCommand(locator, {
      kind: "create",
      schema: "flow",
      input: { source: a, destination: b, bidirectional: true },
    });
    expect(both.after[0].bidirectional).toBe(true);

    const changed = await mcl.runCommand(locator, {
      kind: "update",
      schema: "flow",
      filters: { id: plain.after[0].id },
      input: { bidirectional: true },
    });
    expect(changed.after[0].bidirectional).toBe(true);
  });

  async function createSiteType(mcl: any, locator: any): Promise<string> {
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Site" }, domains: ["physical"] },
    });
    return actorType.after[0].id;
  }

  it("gives an actor no parent_actor by default", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "Plant" }, type },
    });
    expect(after[0].parent_actor ?? null).toBeNull();
  });

  it("gives an actor a parent_actor, lists it in child_actors, and lets it change", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const plants = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: [
        { display_name: { en: "Plant A" }, type },
        { display_name: { en: "Plant B" }, type },
      ],
    });
    const [plantA, plantB] = [plants.after[0].id, plants.after[1].id];
    const workshop = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "Workshop" }, type, parent_actor: plantA },
    });
    const workshopId = workshop.after[0].id;
    expect(workshop.after[0].parent_actor).toBe(plantA);

    const parentA = await mcl.runCommand(locator, { kind: "query", schema: "actor", filters: { id: plantA } });
    expect(parentA.after[0].child_actors).toEqual([workshopId]);

    const moved = await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: workshopId },
      input: { parent_actor: plantB },
    });
    expect(moved.after[0].parent_actor).toBe(plantB);

    const cleared = await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor",
      filters: { id: workshopId },
      input: { parent_actor: null },
    });
    expect(cleared.after[0].parent_actor ?? null).toBeNull();
  });

  it("refuses a parent_actor that is not an existing actor", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor",
        input: { display_name: { en: "Workshop" }, type, parent_actor: "missing" },
      }),
    ).rejects.toThrow();
  });

  it("declares parent_actor as an optional, non-constant relation to actor", () => {
    const actor = SCHEMAS.schemas.find((s) => s.name === "actor") as {
      properties: { name: string; type: string; mandatory?: boolean; constant?: boolean; inverse_name?: string }[];
    };
    const parent = actor.properties.find((p) => p.name === "parent_actor");
    expect(parent).toMatchObject({ type: "actor", inverse_name: "child_actors" });
    expect(parent?.mandatory).toBeUndefined();
    expect(parent?.constant).toBeUndefined();
  });

  it("keeps a transformation_type to a display_name and a description, with no domain", () => {
    const type = SCHEMAS.schemas.find((s) => s.name === "transformation_type") as { properties: { name: string }[] };
    expect(type.properties.map((p) => p.name)).toEqual(["display_name", "description"]);
  });

  it("creates a transformation_type with a generated id", async () => {
    const { mcl, locator } = await setup();
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "transformation_type",
      input: { display_name: { en: "Assembly", fr: "Assemblage" } },
    });
    expect(after[0]).toMatchObject({ display_name: { en: "Assembly", fr: "Assemblage" } });
    expect(typeof after[0].id).toBe("string");
    expect(after[0].id).not.toBe("");
  });

  it("refuses a transformation_type without any display_name language", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, { kind: "create", schema: "transformation_type", input: { display_name: {} } }),
    ).rejects.toThrow();
  });

  it("gives a transformation a mandatory, constant type", async () => {
    const { mcl, locator } = await setup();
    const siteType = await createSiteType(mcl, locator);
    const actor = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "Plant" }, type: siteType },
    });
    const types = await mcl.runCommand(locator, {
      kind: "create",
      schema: "transformation_type",
      input: [{ display_name: { en: "Assembly" } }, { display_name: { en: "Repair" } }],
    });
    const [assembly, repair] = [types.after[0].id, types.after[1].id];

    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "transformation",
        input: { display_name: { en: "Build" }, actor: actor.after[0].id },
      }),
    ).rejects.toThrow();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "transformation",
        input: { display_name: { en: "Build" }, actor: actor.after[0].id, type: "missing" },
      }),
    ).rejects.toThrow();

    const created = await mcl.runCommand(locator, {
      kind: "create",
      schema: "transformation",
      input: { display_name: { en: "Build" }, actor: actor.after[0].id, type: assembly },
    });
    expect(created.after[0].type).toBe(assembly);

    await expect(
      mcl.runCommand(locator, {
        kind: "update",
        schema: "transformation",
        filters: { id: created.after[0].id },
        input: { type: repair },
      }),
    ).rejects.toThrow();

    const assemblyType = await mcl.runCommand(locator, {
      kind: "query",
      schema: "transformation_type",
      filters: { id: assembly },
    });
    expect(assemblyType.after[0].transformations).toEqual([created.after[0].id]);
  });

  const ANNOTATED = [
    "actor_type",
    "item_type",
    "actor",
    "flow",
    "item",
    "item_at_actor",
    "transformation_type",
    "transformation",
    "transformation_line",
    "conversion",
    "scope",
    "location",
  ];

  it("makes every SCFLOW schema extend annotable, which owns the notes and holds the tags", () => {
    const annotable = SCHEMAS.schemas.find((s) => s.name === "annotable") as Record<string, unknown>;
    expect(annotable.extends).toBeUndefined();
    expect(annotable.properties).toEqual([{ name: "tags", type: "tag", is_array: true, is_unique: true }]);
    for (const name of ANNOTATED) {
      expect(SCHEMAS.schemas.find((s) => s.name === name)).toMatchObject({ extends: "annotable" });
    }
    expect(SCHEMAS.schemas.find((s) => s.name === "note")).toMatchObject({
      properties: [
        { name: "annotated", type: "annotable", owner: true, inverse_name: "notes", inverse_is_array: true },
        { name: "content", type: "localized_markdown", min_length: 1 },
      ],
    });
  });

  it("lists the notes of an actor and of a scope, whatever their schema", async () => {
    const { mcl, locator } = await setup();
    const type = await createSiteType(mcl, locator);
    const actor = (
      await mcl.runCommand(locator, { kind: "create", schema: "actor", input: { display_name: { en: "Plant" }, type } })
    ).after[0].id;
    const scope = (
      await mcl.runCommand(locator, { kind: "create", schema: "scope", input: { display_name: { en: "Make" } } })
    ).after[0].id;
    // an inverse with no referrer reads as absent or empty
    expect(
      (await mcl.runCommand(locator, { kind: "query", schema: "actor", filters: { id: actor } })).after[0].notes ?? [],
    ).toEqual([]);

    const onActor = await mcl.runCommand(locator, {
      kind: "create",
      schema: "note",
      input: { annotated: actor, content: { en: "Closed in August", fr: "Fermé en août" } },
    });
    const onScope = await mcl.runCommand(locator, {
      kind: "create",
      schema: "note",
      input: { annotated: scope, content: { en: "Lane of the plants" } },
    });
    expect(onActor.after[0]).toMatchObject({ annotated: actor, content: { en: "Closed in August", fr: "Fermé en août" } });
    expect((await mcl.runCommand(locator, { kind: "query", schema: "actor", filters: { id: actor } })).after[0].notes).toEqual(
      [onActor.after[0].id],
    );
    expect((await mcl.runCommand(locator, { kind: "query", schema: "scope", filters: { id: scope } })).after[0].notes).toEqual(
      [onScope.after[0].id],
    );
  });

  it("refuses a note without any content language", async () => {
    const { mcl, locator } = await setup();
    const scope = (
      await mcl.runCommand(locator, { kind: "create", schema: "scope", input: { display_name: { en: "Make" } } })
    ).after[0].id;
    await expect(
      mcl.runCommand(locator, { kind: "create", schema: "note", input: { annotated: scope, content: {} } }),
    ).rejects.toThrow();
  });

  it("deletes the notes of an entity and of everything it owns with the entity", async () => {
    const { mcl, locator } = await setup();
    const create = async (schema: string, input: Record<string, unknown>): Promise<string> =>
      (await mcl.runCommand(locator, { kind: "create", schema, input })).after[0].id as string;
    const actorType = await create("actor_type", { display_name: { en: "Site" }, domains: ["physical"] });
    const itemType = await create("item_type", { display_name: { en: "Pallet" }, domain: "physical" });
    const transformationType = await create("transformation_type", { display_name: { en: "Assembly" } });
    const actor = await create("actor", { display_name: { en: "Plant" }, type: actorType });
    const item = await create("item", { display_name: { en: "Pallet" }, type: itemType });
    const held = await create("item_at_actor", { actor, item });
    const transformation = await create("transformation", { display_name: { en: "Build" }, actor, type: transformationType });
    const line = await create("transformation_line", { transformation, held_item: held, role: "consumed" });
    const addNote = (annotated: string) => create("note", { annotated, content: { en: "n" } });
    const kept = await addNote(item);
    await addNote(actor);
    await addNote(held);
    await addNote(transformation);
    await addNote(line);

    await mcl.runCommand(locator, { kind: "delete", schema: "actor", filters: { id: actor } });

    const left = await mcl.runCommand(locator, { kind: "query", schema: "note" });
    expect(left.after.map((n: { id: string }) => n.id)).toEqual([kept]);
  });

  it("refuses a duplicate tag on create and on update, and keeps the stored tags", async () => {
    const { mcl, locator } = await setup();
    const actorType = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor_type",
      input: { display_name: { en: "Site" }, domains: ["physical"] },
    });
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "actor",
        input: { display_name: { en: "A" }, type: actorType.after[0].id, tags: ["x", "x"] },
      }),
    ).rejects.toThrow(/more than once/);

    const actor = await mcl.runCommand(locator, {
      kind: "create",
      schema: "actor",
      input: { display_name: { en: "B" }, type: actorType.after[0].id, tags: ["x", "y"] },
    });
    await expect(
      mcl.runCommand(locator, {
        kind: "update",
        schema: "actor",
        filters: { id: actor.after[0].id },
        input: { tags: ["y", "z", "y"] },
      }),
    ).rejects.toThrow(/more than once/);

    const stored = await mcl.runCommand(locator, { kind: "query", schema: "actor", filters: { id: actor.after[0].id } });
    expect(stored.after[0].tags).toEqual(["x", "y"]);
  });

  it("refuses a duplicate tag on a scope, whatever the schema that carries it", async () => {
    const { mcl, locator } = await setup();
    await expect(
      mcl.runCommand(locator, {
        kind: "create",
        schema: "scope",
        input: { display_name: { en: "North" }, tags: ["a", "b", "a"] },
      }),
    ).rejects.toThrow(/more than once/);
  });
});

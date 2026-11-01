import { describe, expect, it } from "vitest";
import { createTestDocument } from "@scfloworg/core-plugin-core/testing";
import { SCHEMAS, createActor } from "../src/index.js";

async function setup() {
  return createTestDocument(SCHEMAS);
}

type Mcl = Awaited<ReturnType<typeof setup>>["mcl"];

async function createScope(mcl: Mcl, locator: string, name: string): Promise<string> {
  const { after } = await mcl.runCommand(locator, {
    kind: "create",
    schema: "scope",
    input: { display_name: { en: name } },
  });
  return after[0].id as string;
}

async function createActorType(mcl: Mcl, locator: string, defaultScope?: string): Promise<string> {
  const { after } = await mcl.runCommand(locator, {
    kind: "create",
    schema: "actor_type",
    input: {
      display_name: { en: "Warehouse" },
      domains: ["physical"],
      ...(defaultScope ? { default_scope: defaultScope } : {}),
    },
  });
  return after[0].id as string;
}

describe("createActor", () => {
  it("creates an actor of the given type and returns it", async () => {
    const { mcl, locator } = await setup();
    const type = await createActorType(mcl, locator);

    const actor = await createActor(mcl, locator, {
      display_name: { en: "Main warehouse" },
      type,
      description: { en: "The central warehouse" },
    });

    expect(actor).toMatchObject({
      display_name: { en: "Main warehouse" },
      description: { en: "The central warehouse" },
      type,
    });
    expect(typeof actor.id).toBe("string");
  });

  it("gives the actor the default scope of its type", async () => {
    const { mcl, locator } = await setup();
    const deliver = await createScope(mcl, locator, "Deliver");
    const type = await createActorType(mcl, locator, deliver);

    const actor = await createActor(mcl, locator, { display_name: { en: "Warehouse" }, type });

    expect(actor.scope).toBe(deliver);
  });

  it("lets an explicit scope override the default scope", async () => {
    const { mcl, locator } = await setup();
    const deliver = await createScope(mcl, locator, "Deliver");
    const make = await createScope(mcl, locator, "Make");
    const type = await createActorType(mcl, locator, deliver);

    const actor = await createActor(mcl, locator, { display_name: { en: "Plant" }, type, scope: make });

    expect(actor.scope).toBe(make);
  });

  it("leaves the actor without scope when the type has no default scope", async () => {
    const { mcl, locator } = await setup();
    const type = await createActorType(mcl, locator);

    const actor = await createActor(mcl, locator, { display_name: { en: "Warehouse" }, type });

    expect(actor.scope ?? null).toBeNull();
  });

  it("applies the default at creation only", async () => {
    const { mcl, locator } = await setup();
    const deliver = await createScope(mcl, locator, "Deliver");
    const make = await createScope(mcl, locator, "Make");
    const type = await createActorType(mcl, locator, deliver);
    const actor = await createActor(mcl, locator, { display_name: { en: "Warehouse" }, type });

    await mcl.runCommand(locator, {
      kind: "update",
      schema: "actor_type",
      filters: { id: type },
      input: { default_scope: make },
    });

    const { after } = await mcl.runCommand(locator, {
      kind: "query",
      schema: "actor",
      filters: { id: actor.id },
    });
    expect(after[0].scope).toBe(deliver);
  });

  it("places the actor at the given location, and at none by default", async () => {
    const { mcl, locator } = await setup();
    const type = await createActorType(mcl, locator);
    const { after } = await mcl.runCommand(locator, {
      kind: "create",
      schema: "location",
      input: { display_name: { en: "Le Havre" } },
    });
    const location = after[0].id as string;

    const placed = await createActor(mcl, locator, { display_name: { en: "Terminal" }, type, location });
    const bare = await createActor(mcl, locator, { display_name: { en: "Depot" }, type });

    expect(placed.location).toBe(location);
    expect(bare.location ?? null).toBeNull();
  });

  it("throws when the given location does not exist, and creates no actor", async () => {
    const { mcl, locator } = await setup();
    const type = await createActorType(mcl, locator);

    await expect(
      createActor(mcl, locator, { display_name: { en: "Terminal" }, type, location: "missing" }),
    ).rejects.toThrow(/location/);

    const { after } = await mcl.runCommand(locator, { kind: "query", schema: "actor" });
    expect(after).toHaveLength(0);
  });

  it("throws when the type does not exist", async () => {
    const { mcl, locator } = await setup();

    await expect(createActor(mcl, locator, { display_name: { en: "Ghost" }, type: "missing" })).rejects.toThrow();
  });

  it("throws when the given scope does not exist", async () => {
    const { mcl, locator } = await setup();
    const type = await createActorType(mcl, locator);

    await expect(
      createActor(mcl, locator, { display_name: { en: "Warehouse" }, type, scope: "missing" }),
    ).rejects.toThrow();
  });
});

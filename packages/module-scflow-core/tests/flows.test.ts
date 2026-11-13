import { describe, expect, it } from "vitest";
import { setupActions } from "./actions-helpers.js";
import { createFlow, getCommonFlowDomains, setFlowItem } from "../src/index.js";

async function setup() {
  return setupActions();
}

type Mcl = Awaited<ReturnType<typeof setup>>["mcl"];

/** Creates an actor whose type belongs to the given flow domains, under `parent` when given; returns the actor id. */
async function createActor(mcl: Mcl, locator: string, domains: string[], parent?: string): Promise<string> {
  const type = await mcl.runCommand(locator, {
    kind: "create",
    schema: "actor_type",
    input: { display_name: { en: "Type" }, domains },
  });
  const actor = await mcl.runCommand(locator, {
    kind: "create",
    schema: "actor",
    input: { display_name: { en: "Actor" }, type: type.after[0].id, ...(parent === undefined ? {} : { parent_actor: parent }) },
  });
  return actor.after[0].id as string;
}

/** Creates an item whose type has the given flow domain; returns the item id. */
async function createItem(mcl: Mcl, locator: string, domain: string, name = "Bolt"): Promise<string> {
  const type = await mcl.runCommand(locator, {
    kind: "create",
    schema: "item_type",
    input: { display_name: { en: `${name} type` }, domain },
  });
  const item = await mcl.runCommand(locator, {
    kind: "create",
    schema: "item",
    input: { display_name: { en: name }, type: type.after[0].id },
  });
  return item.after[0].id as string;
}

/** The `item_at_actor` records, as `actor/item` pairs. */
async function heldPairs(mcl: Mcl, locator: string): Promise<string[]> {
  const { after } = await mcl.runCommand(locator, { kind: "query", schema: "item_at_actor" });
  return after.map((held: any) => `${held.actor}/${held.item}`).sort();
}

async function queryFlows(mcl: Mcl, locator: string) {
  const { after } = await mcl.runCommand(locator, { kind: "query", schema: "flow" });
  return after;
}

describe("getCommonFlowDomains", () => {
  it("lists the flow domains common to the two actors", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical", "information", "financial"]);
    const destination = await createActor(mcl, locator, ["physical", "information", "service"]);

    const domains = await getCommonFlowDomains(mcl, locator, { source, destination });

    expect([...domains].sort()).toEqual(["information", "physical"]);
  });

  it("lists a single domain when the actors have one in common", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical", "financial"]);
    const destination = await createActor(mcl, locator, ["financial", "service"]);

    expect(await getCommonFlowDomains(mcl, locator, { source, destination })).toEqual(["financial"]);
  });

  it("returns an empty list when the actors share no flow domain", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["service"]);

    expect(await getCommonFlowDomains(mcl, locator, { source, destination })).toEqual([]);
  });

  it("creates nothing", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);

    await getCommonFlowDomains(mcl, locator, { source, destination });

    expect(await queryFlows(mcl, locator)).toHaveLength(0);
  });

  it("refuses an unknown actor", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);

    await expect(getCommonFlowDomains(mcl, locator, { source, destination: "missing" })).rejects.toThrow();
  });
});

describe("createFlow with an item", () => {
  it("carries the item and makes both ends hold it", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);
    const item = await createItem(mcl, locator, "physical");

    const flow = await createFlow(mcl, locator, { source, destination, item });

    expect(flow).toMatchObject({ source, destination, item });
    expect(await heldPairs(mcl, locator)).toEqual([`${destination}/${item}`, `${source}/${item}`].sort());
  });

  it("keeps the item at actor that an end already has", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);
    const item = await createItem(mcl, locator, "physical");
    await mcl.runCommand(locator, { kind: "create", schema: "item_at_actor", input: { actor: source, item } });

    await createFlow(mcl, locator, { source, destination, item });

    expect(await heldPairs(mcl, locator)).toEqual([`${destination}/${item}`, `${source}/${item}`].sort());
  });

  it("refuses an item whose domain is not among the domains of an end, and creates nothing", async () => {
    const { mcl, locator, run } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["service"]);
    const item = await createItem(mcl, locator, "physical");

    await expect(run("scflow/create_flow", { source, destination, item })).rejects.toMatchObject({ code: "rule_violation" });

    expect(await queryFlows(mcl, locator)).toHaveLength(0);
    expect(await heldPairs(mcl, locator)).toEqual([]);
  });

  it("refuses an unknown item and creates nothing", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);

    await expect(createFlow(mcl, locator, { source, destination, item: "missing" })).rejects.toThrow(/item/);

    expect(await queryFlows(mcl, locator)).toHaveLength(0);
  });

  it("refuses a flow between an actor and its child without item, in both directions", async () => {
    const { mcl, locator } = await setup();
    const parent = await createActor(mcl, locator, ["physical"]);
    const child = await createActor(mcl, locator, ["physical"], parent);

    await expect(createFlow(mcl, locator, { source: parent, destination: child })).rejects.toThrow(/item/);
    await expect(createFlow(mcl, locator, { source: child, destination: parent })).rejects.toThrow(/item/);

    expect(await queryFlows(mcl, locator)).toHaveLength(0);
  });

  it("accepts a flow between an actor and its child that carries an item", async () => {
    const { mcl, locator } = await setup();
    const parent = await createActor(mcl, locator, ["physical"]);
    const child = await createActor(mcl, locator, ["physical"], parent);
    const item = await createItem(mcl, locator, "physical");

    const flow = await createFlow(mcl, locator, { source: parent, destination: child, item });

    expect(flow).toMatchObject({ source: parent, destination: child, item });
    expect(await heldPairs(mcl, locator)).toEqual([`${child}/${item}`, `${parent}/${item}`].sort());
  });

  it("does not require an item between an actor and a grandchild, or between siblings", async () => {
    const { mcl, locator } = await setup();
    const parent = await createActor(mcl, locator, ["physical"]);
    const first = await createActor(mcl, locator, ["physical"], parent);
    const second = await createActor(mcl, locator, ["physical"], parent);
    const grandchild = await createActor(mcl, locator, ["physical"], first);

    await createFlow(mcl, locator, { source: parent, destination: grandchild });
    await createFlow(mcl, locator, { source: first, destination: second });

    expect(await queryFlows(mcl, locator)).toHaveLength(2);
  });
});

describe("setFlowItem", () => {
  it("sets the item of a flow that has none, and makes both ends hold it", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);
    const item = await createItem(mcl, locator, "physical");
    const created = await createFlow(mcl, locator, { source, destination });

    const flow = await setFlowItem(mcl, locator, { flow: created.id as string, item });

    expect(flow).toMatchObject({ id: created.id, item });
    expect(await heldPairs(mcl, locator)).toEqual([`${destination}/${item}`, `${source}/${item}`].sort());
  });

  it("changes nothing when the flow already carries that item", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);
    const item = await createItem(mcl, locator, "physical");
    const created = await createFlow(mcl, locator, { source, destination, item });

    const flow = await setFlowItem(mcl, locator, { flow: created.id as string, item });

    expect(flow).toMatchObject({ id: created.id, item });
    expect(await heldPairs(mcl, locator)).toHaveLength(2);
  });

  it("refuses to change the item of a flow that carries another one", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);
    const bolt = await createItem(mcl, locator, "physical", "Bolt");
    const nut = await createItem(mcl, locator, "physical", "Nut");
    const created = await createFlow(mcl, locator, { source, destination, item: bolt });

    await expect(setFlowItem(mcl, locator, { flow: created.id as string, item: nut })).rejects.toMatchObject({ code: "constraint_violation" });

    expect((await queryFlows(mcl, locator))[0]).toMatchObject({ item: bolt });
  });

  it("refuses an item whose domain is not among the domains of an end, and changes nothing", async () => {
    const { mcl, locator, run } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["service"]);
    const item = await createItem(mcl, locator, "physical");
    const created = await createFlow(mcl, locator, { source, destination });

    await expect(run("scflow/set_flow_item", { id: created.id, item })).rejects.toMatchObject({ code: "rule_violation" });

    expect((await queryFlows(mcl, locator))[0].item ?? null).toBeNull();
    expect(await heldPairs(mcl, locator)).toEqual([]);
  });

  it("refuses an unknown flow and an unknown item", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);
    const item = await createItem(mcl, locator, "physical");
    const created = await createFlow(mcl, locator, { source, destination });

    await expect(setFlowItem(mcl, locator, { flow: "missing", item })).rejects.toThrow(/flow/);
    await expect(setFlowItem(mcl, locator, { flow: created.id as string, item: "missing" })).rejects.toThrow(/item/);
  });
});

describe("createFlow", () => {
  it("creates one flow from the source to the destination, and returns it", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical", "information"]);
    const destination = await createActor(mcl, locator, ["physical", "information"]);

    const flow = await createFlow(mcl, locator, { source, destination });

    expect(flow).toMatchObject({ source, destination });
    expect(flow).not.toHaveProperty("domain");
    expect(await queryFlows(mcl, locator)).toHaveLength(1);
  });

  it("creates a flow that is not bidirectional unless asked", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);

    const plain = await createFlow(mcl, locator, { source, destination });
    const both = await createFlow(mcl, locator, { source, destination, bidirectional: true });

    expect(plain.bidirectional).toBe(false);
    expect(both.bidirectional).toBe(true);
  });

  it("gives the name, the description and the tags it is given", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);

    const flow = await createFlow(mcl, locator, {
      source,
      destination,
      display_name: { en: "Lane", fr: "Voie" },
      description: { en: "Weekly lane" },
      tags: ["express"],
    });

    expect(flow).toMatchObject({
      display_name: { en: "Lane", fr: "Voie" },
      description: { en: "Weekly lane" },
      tags: ["express"],
    });
  });

  it("does not check the flow domains of the two actors", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["service"]);

    const flow = await createFlow(mcl, locator, { source, destination });

    expect(flow).toMatchObject({ source, destination });
    expect(await queryFlows(mcl, locator)).toHaveLength(1);
  });

  it("creates a new flow at each call, without reusing the existing ones", async () => {
    const { mcl, locator } = await setup();
    const source = await createActor(mcl, locator, ["physical"]);
    const destination = await createActor(mcl, locator, ["physical"]);

    await createFlow(mcl, locator, { source, destination });
    await createFlow(mcl, locator, { source, destination });

    expect(await queryFlows(mcl, locator)).toHaveLength(2);
  });

  it("refuses an unknown actor and creates nothing", async () => {
    const { mcl, locator } = await setup();
    const actor = await createActor(mcl, locator, ["physical"]);

    await expect(createFlow(mcl, locator, { source: actor, destination: "missing" })).rejects.toThrow();
    await expect(createFlow(mcl, locator, { source: "missing", destination: actor })).rejects.toThrow();
    expect(await queryFlows(mcl, locator)).toHaveLength(0);
  });
});

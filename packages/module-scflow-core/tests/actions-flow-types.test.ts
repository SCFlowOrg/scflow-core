import { describe, expect, it } from "vitest";
import { setupActions } from "./actions-helpers.js";

/** Flow types: the schema `flow_type`, the type of a flow, their rules and their actions. */

const refusedBy = (rule: string) => ({ code: "rule_violation", details: { rule } });

/** Two physical sites and an ERP that is information only, a drug and an order, and flow and route types of two domains. */
async function world() {
  const ctx = await setupActions();
  const { run } = ctx;
  await run("scflow/create_actor_type", { name: "Site", domains: ["physical", "information"] });
  await run("scflow/create_actor_type", { name: "ERP", domains: ["information"] });
  await run("scflow/create_actor", { name: "Plant", type: "Site" });
  await run("scflow/create_actor", { name: "Pharmacy", type: "Site" });
  await run("scflow/create_actor", { name: "System", type: "ERP" });
  await run("scflow/create_item_type", { name: "Medicine", domain: "physical" });
  await run("scflow/create_item_type", { name: "Message", domain: "information" });
  await run("scflow/create_item", { name: "Pill", type: "Medicine" });
  await run("scflow/create_item", { name: "Order", type: "Message" });
  const drug = await run("scflow/create_flow_type", { name: "Drug", domain: "physical" });
  await run("scflow/create_flow_type", { name: "Return", domain: "physical", direction: "reverse" });
  await run("scflow/create_flow_type", { name: "Ordering", domain: "information" });
  await run("scflow/create_route_type", { name: "Road", domain: "physical" });
  await run("scflow/create_route_type", { name: "EDI", domain: "information" });
  return { ...ctx, drug };
}

/** A route of the given type with the plant then the pharmacy. */
async function route(run: Awaited<ReturnType<typeof world>>["run"], name: string, routeType: string) {
  await run("scflow/create_route", { name, route_type: routeType });
  await run("scflow/add_route_stop", { route: name, actor: "Plant" });
  await run("scflow/add_route_stop", { route: name, actor: "Pharmacy" });
}

describe("flow types", () => {
  it("creates a flow type with one domain, forward unless a direction is given", async () => {
    const { run, query, drug } = await world();
    expect(drug).toMatchObject({ name: { en: "Drug" }, domain: "physical", direction: "forward" });
    expect((await query("flow_type", { "name.en": "Return" }))[0]).toMatchObject({ direction: "reverse" });
    const peer = await run("scflow/create_flow_type", {
      name: "Subcontracting",
      domain: "physical",
      direction: "same-level",
      description: "To a subcontractor",
      tags: ["peer"],
    });
    expect((await query("flow_type", { id: peer.id }))[0]).toMatchObject({
      direction: "same-level",
      description: { en: "To a subcontractor" },
      tags: ["peer"],
    });
  });

  it("gives the default direction to a flow type created below the actions, and refuses an unknown one", async () => {
    const { run, query, create } = await world();
    const id = await create("flow_type", { name: { en: "Transfer" }, domain: "physical" });
    expect((await query("flow_type", { id }))[0]).toMatchObject({ direction: "forward" });
    await expect(create("flow_type", { name: { en: "Loop" }, domain: "physical", direction: "sideways" })).rejects.toThrow();
    await expect(run("scflow/create_flow_type", { name: "Loop", domain: "physical", direction: "sideways" })).rejects.toThrow();
  });

  it("updates a flow type with the generated action", async () => {
    const { run, query, drug } = await world();
    await run("scflow/update_flow_type", { id: "Drug", direction: "same-level" });
    expect((await query("flow_type", { id: drug.id }))[0]).toMatchObject({ direction: "same-level" });
  });

  it("gives a flow an optional type, changed or removed by update_flow, whatever its bidirectional flag", async () => {
    const { run, query, drug } = await world();
    const untyped = await run("scflow/create_flow", { source: "Plant", destination: "Pharmacy" });
    expect(untyped).not.toHaveProperty("type");

    const typed = await run("scflow/create_flow", { source: "Pharmacy", destination: "Plant", type: "Return", bidirectional: true });
    expect(typed).toMatchObject({ bidirectional: true, type: expect.any(String) });
    expect((await query("flow_type", { id: typed.type }))[0].flows).toEqual([typed.id]);

    await expect(run("scflow/update_flow", { id: untyped.id, type: "Drug" })).resolves.toMatchObject({ type: drug.id });
    expect(await run("scflow/update_flow", { id: untyped.id, type: null })).not.toHaveProperty("type");
  });
});

describe("the rules of a flow type", () => {
  it("carries items of the domain of the type only, and writes nothing when refused", async () => {
    const { run, query } = await world();
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Pharmacy", type: "Drug", item: "Order" })).rejects.toMatchObject(
      refusedBy("flow_item_type_domain"),
    );
    expect(await query("flow")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(0);

    const flow = await run("scflow/create_flow", { source: "Plant", destination: "Pharmacy", type: "Drug", item: "Pill" });
    await expect(run("scflow/update_flow", { id: flow.id, type: "Ordering" })).rejects.toMatchObject(refusedBy("flow_item_type_domain"));
    await expect(run("scflow/update_flow_type", { id: "Drug", domain: "information" })).rejects.toMatchObject({ code: "rule_violation" });
  });

  it("checks the item set later against the domain of the type", async () => {
    const { run } = await world();
    const flow = await run("scflow/create_flow", { source: "Plant", destination: "Pharmacy", type: "Drug" });
    await expect(run("scflow/set_flow_item", { id: flow.id, item: "Order" })).rejects.toMatchObject(refusedBy("flow_item_type_domain"));
    await expect(run("scflow/set_flow_item", { id: flow.id, item: "Pill" })).resolves.toMatchObject({ type: flow.type });
  });

  it("gives a flow without an item the domain of its type, which both ends must have", async () => {
    const { run, query } = await world();
    await expect(run("scflow/create_flow", { source: "Plant", destination: "System", type: "Drug" })).rejects.toMatchObject(
      refusedBy("flow_type_end_domain"),
    );
    await expect(run("scflow/create_flow", { source: "System", destination: "Plant", type: "Drug" })).rejects.toMatchObject(
      refusedBy("flow_type_end_domain"),
    );
    expect(await query("flow")).toHaveLength(0);

    await run("scflow/create_flow", { source: "Plant", destination: "System", type: "Ordering" });
    await expect(run("scflow/update_actor", { id: "System", type: "Site" })).resolves.toBeDefined();
  });

  it("gives a flow without an item the domain of its type on a route", async () => {
    const { run } = await world();
    await route(run, "Truck", "Road");
    await route(run, "Wire", "EDI");
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Pharmacy", type: "Drug", route: "Wire" })).rejects.toMatchObject(
      refusedBy("route_flow_type_domain"),
    );
    const flow = await run("scflow/create_flow", { source: "Plant", destination: "Pharmacy", type: "Drug" });
    await expect(run("scflow/set_flow_route", { id: flow.id, route: "Wire" })).rejects.toMatchObject(refusedBy("route_flow_type_domain"));
    await expect(run("scflow/create_route_from_flows", { flows: [flow.id], route_type: "EDI", name: "Fax" })).rejects.toMatchObject(
      refusedBy("route_flow_type_domain"),
    );
    await run("scflow/set_flow_route", { id: flow.id, route: "Truck" });
    await expect(run("scflow/update_route", { id: "Truck", route_type: "EDI" })).rejects.toMatchObject(refusedBy("route_flow_type_domain"));
    await expect(run("scflow/update_flow", { id: flow.id, type: "Ordering" })).rejects.toMatchObject(refusedBy("route_flow_type_domain"));
  });
});

describe("scflow/delete_flow_type", () => {
  it("is refused while flows have the type, and deletes them with cascade, keeping the others", async () => {
    const { run, query } = await world();
    const typed = await run("scflow/create_flow", { source: "Plant", destination: "Pharmacy", type: "Drug", item: "Pill" });
    const other = await run("scflow/create_flow", { source: "Pharmacy", destination: "Plant", type: "Return", item: "Pill" });
    await run("scflow/add_note", { annotated: typed.id, content: "Daily" });

    await expect(run("scflow/delete_flow_type", { id: "Drug" })).rejects.toMatchObject({ code: "constraint_violation" });

    const impact = await run("scflow/inspect_delete_impact", { targets: [{ schema: "flow_type", ref: "Drug" }] });
    expect(impact.cascaded.flows.map((flow: { id: string }) => flow.id)).toEqual([typed.id]);
    expect(impact.counts).toMatchObject({ flows: 1, notes: 1 });

    await run("scflow/delete_flow_type", { id: "Drug", cascade: true });
    expect((await query("flow")).map((flow) => flow.id)).toEqual([other.id]);
    expect(await query("note")).toHaveLength(0);
    expect(await query("item_at_actor")).toHaveLength(2);
  });

  it("deletes a type that no flow has", async () => {
    const { run, query } = await world();
    await run("scflow/delete_flow_type", { id: "Ordering" });
    expect(await query("flow_type", { "name.en": "Ordering" })).toHaveLength(0);
  });
});

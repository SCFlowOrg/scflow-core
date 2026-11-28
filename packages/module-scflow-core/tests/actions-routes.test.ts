import { describe, expect, it } from "vitest";
import { setupActions } from "./actions-helpers.js";

/**
 * Routes of flows: the schemas `route_type`, `route` and `route_stop`, the route of a flow, their rules
 * and their actions (`docs/spec/flow-model.md`, Route).
 */

const refusedBy = (rule: string) => ({ code: "rule_violation", details: { rule } });

/** Four physical sites, a physical and an information item, a road and an EDI route type. */
async function world() {
  const setup = await setupActions();
  const { run } = setup;
  await run("scflow/create_actor_type", { name: "Site", domains: ["physical", "information"] });
  await run("scflow/create_item_type", { name: "Part", domain: "physical" });
  await run("scflow/create_item_type", { name: "Message", domain: "information" });
  const plant = await run("scflow/create_actor", { name: "Plant", type: "Site" });
  const depot = await run("scflow/create_actor", { name: "Depot", type: "Site" });
  const shop = await run("scflow/create_actor", { name: "Shop", type: "Site" });
  const hub = await run("scflow/create_actor", { name: "Hub", type: "Site" });
  await run("scflow/create_item", { name: "Bolt", type: "Part" });
  await run("scflow/create_item", { name: "Nut", type: "Part" });
  await run("scflow/create_item", { name: "Order", type: "Message" });
  await run("scflow/create_route_type", { name: "Road", domain: "physical" });
  await run("scflow/create_route_type", { name: "EDI", domain: "information" });
  return { ...setup, plant, depot, shop, hub };
}

/** A weekly round trip Plant, Depot, Shop, Plant on the road. */
async function roundTrip() {
  const ctx = await world();
  const { run } = ctx;
  const route = await run("scflow/create_route", { name: "Milk run", route_type: "Road", schedule: "every Monday" });
  await run("scflow/add_route_stop", { route: "Milk run", actor: "Plant" });
  await run("scflow/add_route_stop", { route: "Milk run", actor: "Depot", lead_time: "P1D" });
  await run("scflow/add_route_stop", { route: "Milk run", actor: "Shop", lead_time: "PT6H" });
  await run("scflow/add_route_stop", { route: "Milk run", actor: "Plant", lead_time: "P1DT2H" });
  return { ...ctx, route };
}

describe("route types and routes", () => {
  it("creates a route type with one domain, and a one-way route of that route type with no stop", async () => {
    const { run, query } = await world();
    const routeType = (await query("route_type", { "name.en": "Road" }))[0];
    expect(routeType).toMatchObject({ domain: "physical" });

    const route = await run("scflow/create_route", { name: "Shuttle", route_type: "Road", schedule: "daily" });
    expect(route).toEqual({
      id: expect.any(String),
      name: "Shuttle",
      route_type: routeType.id,
      bidirectional: false,
      schedule: { en: "daily" },
      stops: [],
      flows: [],
    });
  });

  it("refuses a route without a route type", async () => {
    const { run } = await world();
    await expect(run("scflow/create_route", { name: "Shuttle" })).rejects.toThrow(/route_type/);
  });

  it("orders the stops, lets an actor have several, and inserts a stop at a position", async () => {
    const { run, plant, depot, shop, hub } = await roundTrip();
    const stop = await run("scflow/add_route_stop", { route: "Milk run", actor: "Hub", sequence: 2, lead_time: "PT3H" });
    expect(stop).toMatchObject({ actor: hub.id, sequence: 2, lead_time: "PT3H" });

    const { stops } = await run("scflow/inspect_route", { id: "Milk run" });
    expect(stops.map((s: { actor: string }) => s.actor)).toEqual([plant.id, hub.id, depot.id, shop.id, plant.id]);
    expect(stops.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a sequence beyond the end, and two stops of a route with one sequence", async () => {
    const { run, create, route, plant } = await roundTrip();
    await expect(run("scflow/add_route_stop", { route: "Milk run", actor: "Hub", sequence: 6 })).rejects.toThrow(/beyond/);
    await expect(create("route_stop", { route: route.id, actor: plant.id, sequence: 2 })).rejects.toMatchObject(
      refusedBy("route_stop_sequence_unique"),
    );
  });

  it("refuses a lead time that is not an ISO 8601 duration", async () => {
    const { run } = await roundTrip();
    await expect(run("scflow/add_route_stop", { route: "Milk run", actor: "Hub", lead_time: "2 days" })).rejects.toThrow(/lead_time/);
  });
});

describe("the route of a flow", () => {
  it("is never created with a flow, and is given by create_flow or set_flow_route", async () => {
    const { run, query, route } = await roundTrip();
    const plain = await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    expect(plain).not.toHaveProperty("route");
    expect(await query("route")).toHaveLength(1);

    expect(await run("scflow/set_flow_route", { id: plain.id, route: "Milk run" })).toMatchObject({ route: route.id });
    const other = await run("scflow/create_flow", { source: "Depot", destination: "Shop", item: "Nut", route: "Milk run" });
    expect(other).toMatchObject({ route: route.id });
    expect((await run("scflow/inspect_route", { id: "Milk run" })).flows).toEqual([plain.id, other.id]);

    expect(await run("scflow/set_flow_route", { id: plain.id, route: null })).not.toHaveProperty("route");
  });

  it("needs the source and the destination among the stops of the route", async () => {
    const { run, query } = await roundTrip();
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Hub", route: "Milk run" })).rejects.toMatchObject(
      refusedBy("route_stops_hold_flow_ends"),
    );
    expect(await query("flow")).toHaveLength(0);
  });

  it("needs a stop of the source before a stop of the destination on a one-way route", async () => {
    const { run } = await roundTrip();
    await expect(run("scflow/create_flow", { source: "Shop", destination: "Plant", route: "Milk run" })).resolves.toBeDefined();
    await expect(run("scflow/create_flow", { source: "Depot", destination: "Plant", route: "Milk run" })).resolves.toBeDefined();
    await expect(run("scflow/create_flow", { source: "Shop", destination: "Depot", route: "Milk run" })).rejects.toThrow(/route_serves_flow/);
  });

  it("serves a bidirectional flow when the stops hold both directions, or when the route is bidirectional", async () => {
    const { run } = await roundTrip();
    // Plant, Depot, ..., Plant serves Depot to Plant too.
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Depot", bidirectional: true, route: "Milk run" })).resolves.toBeDefined();
    await expect(run("scflow/create_flow", { source: "Depot", destination: "Shop", bidirectional: true, route: "Milk run" })).rejects.toThrow(
      /route_serves_flow/,
    );
    await run("scflow/update_route", { id: "Milk run", bidirectional: true });
    await expect(run("scflow/create_flow", { source: "Shop", destination: "Depot", bidirectional: true, route: "Milk run" })).resolves.toBeDefined();
  });

  it("refuses to make a flow bidirectional, or its route one-way, when the other direction is not served", async () => {
    const { run } = await roundTrip();
    const flow = await run("scflow/create_flow", { source: "Depot", destination: "Shop", route: "Milk run" });
    await expect(run("scflow/update_flow", { id: flow.id, bidirectional: true })).rejects.toThrow(/route_serves_flow/);

    await run("scflow/update_route", { id: "Milk run", bidirectional: true });
    await run("scflow/update_flow", { id: flow.id, bidirectional: true });
    await expect(run("scflow/update_route", { id: "Milk run", bidirectional: false })).rejects.toThrow(/route_serves_flow/);
  });

  it("carries items of the domain of the route type only", async () => {
    const { run } = await roundTrip();
    await expect(run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Order", route: "Milk run" })).rejects.toMatchObject(
      refusedBy("route_item_domain"),
    );
    const empty = await run("scflow/create_flow", { source: "Plant", destination: "Depot", route: "Milk run" });
    await expect(run("scflow/set_flow_item", { id: empty.id, item: "Order" })).rejects.toMatchObject(refusedBy("route_item_domain"));
    await run("scflow/set_flow_item", { id: empty.id, item: "Bolt" });
    await expect(run("scflow/update_route", { id: "Milk run", route_type: "EDI" })).rejects.toMatchObject(refusedBy("route_item_domain"));
  });
});

describe("moving and removing stops", () => {
  it("moves a stop, keeps the others in order, and refuses a move after which a flow is no longer served", async () => {
    const { run, plant, depot, shop } = await roundTrip();
    const { stops } = await run("scflow/inspect_route", { id: "Milk run" });
    const [, depotStop, shopStop] = stops;

    const moved = await run("scflow/update_route_stop", { id: shopStop.id, sequence: 2, lead_time: "PT5H" });
    expect(moved).toMatchObject({ sequence: 2, lead_time: "PT5H" });
    let order = (await run("scflow/inspect_route", { id: "Milk run" })).stops.map((s: { actor: string }) => s.actor);
    expect(order).toEqual([plant.id, shop.id, depot.id, plant.id]);

    await run("scflow/create_flow", { source: "Shop", destination: "Depot", route: "Milk run" });
    await expect(run("scflow/update_route_stop", { id: depotStop.id, sequence: 2 })).rejects.toThrow(/route_serves_flow/);
    order = (await run("scflow/inspect_route", { id: "Milk run" })).stops.map((s: { actor: string }) => s.actor);
    expect(order).toEqual([plant.id, shop.id, depot.id, plant.id]);
  });

  it("removes a stop without flow and renumbers, and refuses to remove a stop a flow needs", async () => {
    const { run } = await roundTrip();
    await run("scflow/create_flow", { source: "Plant", destination: "Depot", route: "Milk run" });
    const { stops } = await run("scflow/inspect_route", { id: "Milk run" });

    await expect(run("scflow/remove_route_stop", { id: stops[1].id })).rejects.toMatchObject(refusedBy("route_stops_hold_flow_ends"));
    await run("scflow/remove_route_stop", { id: stops[2].id });
    const after = (await run("scflow/inspect_route", { id: "Milk run" })).stops;
    expect(after.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2, 3]);
  });
});

describe("scflow/inspect_route", () => {
  it("derives the lead time of each flow, both ways for a bidirectional flow, and lists the stops without flow", async () => {
    const { run, route, plant, shop } = await roundTrip();
    await run("scflow/add_route_stop", { route: "Milk run", actor: "Hub", lead_time: "PT1H" });
    const out = await run("scflow/create_flow", { source: "Plant", destination: "Shop", item: "Bolt", route: "Milk run" });
    const both = await run("scflow/create_flow", { source: "Plant", destination: "Depot", bidirectional: true, route: "Milk run" });

    const inspected = await run("scflow/inspect_route", { id: "Milk run" });
    expect(inspected).toMatchObject({ id: route.id, domain: "physical", bidirectional: false, schedule: { en: "every Monday" } });
    expect(inspected.lead_times).toEqual([
      { id: out.id, source: plant.id, destination: shop.id, bidirectional: false, item: expect.any(String), lead_time: "P1DT6H" },
      { id: both.id, source: plant.id, destination: both.destination, bidirectional: true, lead_time: "P1D", reverse_lead_time: "P1DT8H" },
    ]);
    expect(inspected.stops_without_flow).toEqual([inspected.stops[4].id]);
  });

  it("uses the reverse lead times on a bidirectional route, and gives null when a leg has no lead time", async () => {
    const { run } = await world();
    await run("scflow/create_route", { name: "Shuttle", route_type: "Road", bidirectional: true });
    await run("scflow/add_route_stop", { route: "Shuttle", actor: "Plant" });
    await run("scflow/add_route_stop", { route: "Shuttle", actor: "Depot", lead_time: "PT4H", reverse_lead_time: "PT5H" });
    await run("scflow/add_route_stop", { route: "Shuttle", actor: "Shop" });
    await run("scflow/create_flow", { source: "Depot", destination: "Plant", route: "Shuttle" });
    await run("scflow/create_flow", { source: "Plant", destination: "Shop", route: "Shuttle" });

    const { lead_times } = await run("scflow/inspect_route", { id: "Shuttle" });
    expect(lead_times.map((flow: { lead_time: string | null }) => flow.lead_time)).toEqual(["PT5H", null]);
  });
});

describe("scflow/create_route_from_flows", () => {
  it("creates a route with two stops for flows that share their ends, and makes them travel on it", async () => {
    const { run, plant, depot } = await world();
    const bolts = await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    const nuts = await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Nut", bidirectional: true });

    const route = await run("scflow/create_route_from_flows", { flows: [bolts.id, nuts.id], route_type: "Road", name: "Truck", lead_time: "P2D" });
    expect(route).toMatchObject({ name: "Truck", bidirectional: true, flows: [bolts.id, nuts.id] });
    expect(route.stops).toMatchObject([
      { actor: plant.id, sequence: 1 },
      { actor: depot.id, sequence: 2, lead_time: "P2D" },
    ]);
  });

  it("refuses flows with other ends, a flow already on a route, and items outside the domain of the route type", async () => {
    const { run, query } = await world();
    const a = await run("scflow/create_flow", { source: "Plant", destination: "Depot", item: "Bolt" });
    const b = await run("scflow/create_flow", { source: "Depot", destination: "Plant", item: "Bolt" });
    await expect(run("scflow/create_route_from_flows", { flows: [a.id, b.id], route_type: "Road", name: "Truck" })).rejects.toThrow(/share/);
    await expect(run("scflow/create_route_from_flows", { flows: [a.id], route_type: "EDI", name: "Wire" })).rejects.toMatchObject(
      refusedBy("route_item_domain"),
    );
    expect(await query("route")).toHaveLength(0);

    await run("scflow/create_route_from_flows", { flows: [a.id], route_type: "Road", name: "Truck" });
    await expect(run("scflow/create_route_from_flows", { flows: [a.id], route_type: "Road", name: "Van" })).rejects.toThrow(/already/);
  });
});

describe("deleting routes, route types and actors", () => {
  it("refuses to delete a route with flows unless cascade, which keeps the flows on no route", async () => {
    const { run, query } = await roundTrip();
    const flow = await run("scflow/create_flow", { source: "Plant", destination: "Depot", route: "Milk run" });
    await expect(run("scflow/delete_route", { id: "Milk run" })).rejects.toThrow(/cascade/);

    await run("scflow/delete_route", { id: "Milk run", cascade: true });
    expect(await query("route")).toHaveLength(0);
    expect(await query("route_stop")).toHaveLength(0);
    expect((await query("flow", { id: flow.id }))[0].route).toBeFalsy();
  });

  it("deletes the routes of a route type with cascade", async () => {
    const { run, query } = await roundTrip();
    await expect(run("scflow/delete_route_type", { id: "Road" })).rejects.toMatchObject({ code: "constraint_violation" });
    await run("scflow/delete_route_type", { id: "Road", cascade: true });
    expect(await query("route")).toHaveLength(0);
  });

  it("deletes the stops of an actor with it, and the next action on the stops closes the gap", async () => {
    const { run, query } = await roundTrip();
    const impact = await run("scflow/inspect_delete_impact", { targets: [{ schema: "actor", ref: "Plant" }] });
    expect(impact.cascaded.routeStops).toBe(2);
    expect(impact.counts).toMatchObject({ routeStops: 2, total: 2 });

    await expect(run("scflow/delete_actor", { id: "Depot" })).rejects.toMatchObject({ code: "constraint_violation" });
    await run("scflow/delete_actor", { id: "Depot", cascade: true });
    expect(await query("route_stop")).toHaveLength(3);

    await run("scflow/add_route_stop", { route: "Milk run", actor: "Hub" });
    const { stops } = await run("scflow/inspect_route", { id: "Milk run" });
    expect(stops.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2, 3, 4]);
  });
});

import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions as setup } from "./actions-helpers.js";

/** Creates an actor type, an actor "Plant", a scope "North" and returns their ids. */
async function withEntities() {
  const ctx = await setup();
  await ctx.run("scflow/create_actor_type", { display_name: "Site", domains: ["physical"] });
  const actor = await ctx.run("scflow/create_actor", { display_name: "Plant", type: "Site" });
  const other = await ctx.run("scflow/create_actor", { display_name: "Depot", type: "Site" });
  const scope = await ctx.run("scflow/create_scope", { display_name: "North" });
  const flow = await ctx.run<Record<string, any>>("scflow/create_flow", {
    source: "Plant",
    destination: "Depot",
  });
  return { ...ctx, actor, other, scope, flow };
}

describe("note actions", () => {
  it("are declared with scoped unique ids, and only find_notes and inspect_delete_impact are read actions", () => {
    const notes = ACTIONS.filter((action) => /^scflow\/(add|update|remove)_note$|^scflow\/find_notes$/.test(action.id));

    expect(notes.map((action) => action.id).sort()).toEqual([
      "scflow/add_note",
      "scflow/find_notes",
      "scflow/remove_note",
      "scflow/update_note",
    ]);
    expect(new Set(ACTIONS.map((action) => action.id)).size).toBe(ACTIONS.length);
    expect(ACTIONS.filter((action) => action.kind === "read").map((action) => action.id)).toEqual([
      "scflow/find_notes",
      "scflow/inspect_delete_impact",
    ]);
  });
});

describe("scflow/add_note", () => {
  it("adds a note to an actor, a flow and a scope, stores a plain string as English", async () => {
    const { run, query, actor, flow, scope } = await withEntities();

    const onActor = await run("scflow/add_note", { annotated: actor.id, content: "Check capacity" });
    const onFlow = await run("scflow/add_note", { annotated: flow.id, content: "Weekly" });
    const onScope = await run("scflow/add_note", { annotated: scope.id, content: "Region" });

    expect(onActor).toMatchObject({ entity: actor.id, content: { en: "Check capacity" } });
    expect(typeof onActor.id).toBe("string");
    expect(onFlow).toMatchObject({ entity: flow.id });
    expect(onScope).toMatchObject({ entity: scope.id });
    expect(await query("note")).toHaveLength(3);
  });

  it("keeps a localized map as given", async () => {
    const { run, actor } = await withEntities();

    const note = await run("scflow/add_note", { annotated: actor.id, content: { en: "Hello", fr: "Bonjour" } });

    expect(note.content).toEqual({ en: "Hello", fr: "Bonjour" });
  });

  it("allows the same text twice", async () => {
    const { run, query, actor } = await withEntities();

    await run("scflow/add_note", { annotated: actor.id, content: "Same" });
    await run("scflow/add_note", { annotated: actor.id, content: "Same" });

    expect(await query("note", { annotated: actor.id })).toHaveLength(2);
  });

  it("refuses an unknown entity and a missing entity", async () => {
    const { run, query } = await withEntities();

    await expect(run("scflow/add_note", { annotated: "no-such-id", content: "x" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/add_note", { content: "x" })).rejects.toThrow(/annotated/);
    expect(await query("note")).toHaveLength(0);
  });

  it("refuses an empty or missing content", async () => {
    const { run, query, actor } = await withEntities();

    await expect(run("scflow/add_note", { annotated: actor.id, content: "" })).rejects.toThrow(/content/);
    await expect(run("scflow/add_note", { annotated: actor.id })).rejects.toThrow(/content/);
    expect(await query("note")).toHaveLength(0);
  });
});

describe("scflow/update_note", () => {
  it("replaces the given language and keeps the others", async () => {
    const { run, actor } = await withEntities();
    const note = await run("scflow/add_note", { annotated: actor.id, content: { en: "Old", fr: "Ancien" } });

    const updated = await run("scflow/update_note", { id: note.id, content: { en: "New" } });

    expect(updated).toEqual({ id: note.id, entity: actor.id, content: { en: "New", fr: "Ancien" } });
  });

  it("changes the English text when given a plain string", async () => {
    const { run, query, actor } = await withEntities();
    const note = await run("scflow/add_note", { annotated: actor.id, content: "Old" });

    await run("scflow/update_note", { id: note.id, content: "New" });

    const [stored] = await query("note", { id: note.id });
    expect(stored.content).toEqual({ en: "New" });
    expect(stored.annotated).toBe(actor.id);
  });

  it("refuses an unknown note and an empty content", async () => {
    const { run, actor } = await withEntities();
    const note = await run("scflow/add_note", { annotated: actor.id, content: "Keep" });

    await expect(run("scflow/update_note", { id: "no-such-id", content: "x" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/update_note", { id: note.id, content: "" })).rejects.toThrow(/content/);
  });
});

describe("scflow/remove_note", () => {
  it("deletes only that note and returns its id", async () => {
    const { run, query, actor } = await withEntities();
    const first = await run("scflow/add_note", { annotated: actor.id, content: "One" });
    const second = await run("scflow/add_note", { annotated: actor.id, content: "Two" });

    const removed = await run("scflow/remove_note", { id: first.id });

    expect(removed).toEqual({ id: first.id });
    expect((await query("note")).map((note) => note.id)).toEqual([second.id]);
    expect(await query("actor", { id: actor.id })).toHaveLength(1);
  });

  it("refuses an unknown note", async () => {
    const { run } = await withEntities();

    await expect(run("scflow/remove_note", { id: "no-such-id" })).rejects.toThrow(/names no instance/);
  });
});

describe("scflow/find_notes", () => {
  it("lists only the notes of the entity", async () => {
    const { run, actor, other } = await withEntities();
    const one = await run("scflow/add_note", { annotated: actor.id, content: "One" });
    const two = await run("scflow/add_note", { annotated: actor.id, content: { fr: "Deux" } });
    await run("scflow/add_note", { annotated: other.id, content: "Elsewhere" });

    const notes = await run<Record<string, any>[]>("scflow/find_notes", { entity: actor.id });

    expect(notes).toHaveLength(2);
    expect(notes).toEqual(
      expect.arrayContaining([
        { id: one.id, entity: actor.id, content: { en: "One" } },
        { id: two.id, entity: actor.id, content: { fr: "Deux" } },
      ]),
    );
  });

  it("gives an empty list for an entity without a note", async () => {
    const { run, actor } = await withEntities();

    expect(await run("scflow/find_notes", { entity: actor.id })).toEqual([]);
  });

  it("refuses an unknown or missing entity", async () => {
    const { run } = await withEntities();

    await expect(run("scflow/find_notes", { entity: "no-such-id" })).rejects.toThrow(/names no instance/);
    await expect(run("scflow/find_notes", {})).rejects.toThrow(/entity/);
  });
});

describe("notes and deletion", () => {
  it("a deleted actor takes its notes along", async () => {
    const { run, query, actor, other } = await withEntities();
    await run("scflow/add_note", { annotated: actor.id, content: "Gone" });
    const kept = await run("scflow/add_note", { annotated: other.id, content: "Kept" });

    await run("scflow/delete_actor", { id: actor.id, cascade: true });

    expect((await query("note")).map((note) => note.id)).toEqual([kept.id]);
  });
});

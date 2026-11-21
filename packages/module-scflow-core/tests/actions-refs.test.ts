import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/index.js";
import { setupActions } from "./actions-helpers.js";
import { localizedText, toLocalized } from "../src/actions/text.js";

async function setup() {
  return setupActions();
}

/** Resolves a reference to an actor or a scope through an action that takes `ref` targets, and gives its id. */
async function target(run: (id: string, params: Record<string, unknown>) => Promise<any>, schema: string, ref: string): Promise<string> {
  const result = await run("scflow/inspect_delete_impact", { targets: [{ schema, ref }] });
  return result.targets[0].id as string;
}

/** Country / Site / Line: `Line 1` exists under two sites, `Lyon` under two countries. */
async function world() {
  const ctx = await setup();
  const { run } = ctx;
  await run("scflow/create_actor_type", { name: "Place", domains: ["physical"] });
  const france = await run("scflow/create_actor", { name: "France", type: "Place" });
  const canada = await run("scflow/create_actor", { name: "Canada", type: "Place" });
  const lyonFr = await run("scflow/create_actor", { name: "Lyon", type: "Place", parent_actor: "France" });
  const lyonCa = await run("scflow/create_actor", { name: "Lyon", type: "Place", parent_actor: "Canada" });
  const paris = await run("scflow/create_actor", { name: "Paris", type: "Place", parent_actor: "France" });
  const lineLyonFr = await run("scflow/create_actor", { name: "Line 1", type: "Place", parent_actor: lyonFr.id });
  const lineLyonCa = await run("scflow/create_actor", { name: "Line 1", type: "Place", parent_actor: lyonCa.id });
  const lineParis = await run("scflow/create_actor", { name: "Line 1", type: "Place", parent_actor: paris.id });
  const assembly = await run("scflow/create_actor", { name: "Assembly", type: "Place", parent_actor: paris.id });
  return { ...ctx, france, canada, lyonFr, lyonCa, paris, lineLyonFr, lineLyonCa, lineParis, assembly };
}

describe("references by name", () => {
  it("resolves an id, and a name that is unique, in any depth", async () => {
    const { run, france, assembly, lineParis } = await world();

    expect(await target(run, "actor", france.id)).toBe(france.id);
    expect(await target(run, "actor", "France")).toBe(france.id);
    expect(await target(run, "actor", "Assembly")).toBe(assembly.id);
    expect(await target(run, "actor", "Paris / Line 1")).toBe(lineParis.id);
  });

  it("resolves the shortest suffix of the three-level chain Country / Site / Line", async () => {
    const { run, lineLyonFr, lineLyonCa } = await world();

    expect(await target(run, "actor", "France / Lyon / Line 1")).toBe(lineLyonFr.id);
    expect(await target(run, "actor", "France/Lyon/Line 1")).toBe(lineLyonFr.id);
    expect(await target(run, "actor", "Canada / Lyon / Line 1")).toBe(lineLyonCa.id);
    // a level in the middle may not be skipped
    await expect(target(run, "actor", "France / Line 1")).rejects.toThrow(/designates no instance/);
  });

  it("lists the full qualified names of the candidates when a name is ambiguous", async () => {
    const { run } = await world();

    const error = (await target(run, "actor", "Line 1").catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/designates 3 instances/);
    for (const candidate of ["Canada / Lyon / Line 1", "France / Lyon / Line 1", "France / Paris / Line 1"]) {
      expect(error.message).toContain(`"${candidate}"`);
    }

    // two sites called Lyon: the parent is ambiguous too
    const lyon = (await target(run, "actor", "Lyon / Line 1").catch((e: Error) => e)) as Error;
    expect(lyon.message).toContain('"Canada / Lyon / Line 1", "France / Lyon / Line 1"');
  });

  it("is refused in a parameter of an action, with the candidates, and writes nothing", async () => {
    const { run, query } = await world();

    await expect(run("scflow/update_actor", { id: "Lyon", name: "Lyon 2" })).rejects.toThrow(/"Canada \/ Lyon", "France \/ Lyon"/);
    expect((await query("actor")).filter((actor) => actor.name === "Lyon 2")).toHaveLength(0);
  });

  it("lets two plants each have a line of the same name, and refuses a second one in one plant", async () => {
    const { run, query, lyonFr } = await world();

    await expect(run("scflow/create_actor", { name: "Line 1", type: "Place", parent_actor: lyonFr.id })).rejects.toThrow(/name_scope/);
    expect((await query("actor")).filter((actor) => actor.name === "Line 1")).toHaveLength(3);
  });

  it("returns the reference of an actor, qualified when its name is shared", async () => {
    const { run, lyonFr, lyonCa, lineParis } = await world();

    expect((await run("scflow/create_actor", { name: "Line 2", type: "Place", parent_actor: lyonFr.id })).reference).toBe("Line 2");
    expect(lyonCa.reference).toBe("Canada / Lyon");
    expect(lineParis.reference).toBe("Paris / Line 1");
    const shared = await run("scflow/create_actor", { name: "Line 1", type: "Place", parent_actor: "France / Paris / Assembly" });
    expect(shared.reference).toBe("Assembly / Line 1");
  });

  it("accepts a localized name of a type in any language, and a plain string for it", async () => {
    const { run } = await setup();
    const type = await run("scflow/create_actor_type", { name: { en: "Factory", fr: "Usine" }, domains: ["physical"] });

    const byEnglish = await run("scflow/create_actor", { name: "Plant", type: "Factory" });
    const byFrench = await run("scflow/create_actor", { name: "Plant 2", type: "Usine" });

    expect(byEnglish.type).toBe(type.id);
    expect(byFrench.type).toBe(type.id);
    expect(await run("scflow/create_scope", { name: "Make" })).toMatchObject({ name: { en: "Make" } });
  });

  it("matches a name exactly, not as a substring or in another case", async () => {
    const { run } = await world();

    await expect(target(run, "actor", "Franc")).rejects.toThrow(/designates no instance/);
    await expect(target(run, "actor", "france")).rejects.toThrow(/designates no instance/);
  });

  it("prefers an id over a name that equals it", async () => {
    const { run, france } = await world();

    expect(await target(run, "actor", france.id)).toBe(france.id);
  });

  it("describes how to write a reference in the declaration of every reference parameter", async () => {
    const params = (id: string) => JSON.stringify(ACTIONS.find((action) => action.id === id)?.parameters);
    expect(params("scflow/create_actor")).toContain("as short as it stays unambiguous");
    expect(params("scflow/create_actor")).toContain("never give an id you were not given");
    expect(params("scflow/create_actor")).toContain("source language of the project");
    expect(params("scflow/delete_flow")).not.toContain("unambiguous");
  });
});

describe("toLocalized", () => {
  it("stores a plain string under en", () => {
    expect(toLocalized("Main warehouse")).toEqual({ en: "Main warehouse" });
  });

  it("stores a plain string under the language given", () => {
    expect(toLocalized("Entrepôt principal", "fr")).toEqual({ fr: "Entrepôt principal" });
  });

  it("keeps a localized map as it is", () => {
    expect(toLocalized({ en: "Warehouse", fr: "Entrepôt" })).toEqual({ en: "Warehouse", fr: "Entrepôt" });
  });

});

describe("localizedText", () => {
  it("writes a plain string in the source language of the dataset", async () => {
    const { mcl, locator } = await setupActions({ languages: ["fr", "en"] });
    const context = { ...mcl, locator } as never;
    expect(await localizedText(context, "Entrepôt")).toEqual({ fr: "Entrepôt" });
  });

  it("writes it under en when the dataset states no language", async () => {
    const { mcl, locator } = await setupActions();
    const context = { ...mcl, locator } as never;
    expect(await localizedText(context, "Warehouse")).toEqual({ en: "Warehouse" });
  });

  it("keeps a map as it is, whatever the languages", async () => {
    const { mcl, locator } = await setupActions({ languages: ["fr"] });
    const context = { ...mcl, locator } as never;
    expect(await localizedText(context, { en: "Warehouse", de: "Lager" })).toEqual({ en: "Warehouse", de: "Lager" });
  });

  it("is what an action does with a plain string", async () => {
    const { run } = await setupActions({ languages: ["fr", "en"] });
    const scope = await run("scflow/create_scope", { name: "Fabrication" });
    expect(scope.name).toEqual({ fr: "Fabrication" });
  });
});

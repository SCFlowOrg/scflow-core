import { describe, expect, it } from "vitest";
import { setupActions } from "./actions-helpers.js";
import { resolveRef } from "../src/actions/refs.js";
import { toLocalized } from "../src/actions/text.js";

async function setup() {
  return setupActions();
}

type Mcl = Awaited<ReturnType<typeof setup>>["mcl"];

async function createScope(mcl: Mcl, locator: string, display_name: Record<string, string>): Promise<string> {
  const { after } = await mcl.runCommand(locator, {
    kind: "create",
    schema: "scope",
    input: { display_name },
  });
  return after[0].id as string;
}

describe("resolveRef", () => {
  it("resolves an id", async () => {
    const { mcl, locator } = await setup();
    const context = { ...mcl, locator };
    const id = await createScope(mcl, locator, { en: "Make" });

    const scope = await resolveRef(context, "scflow.scope", id, "scope");

    expect(scope.id).toBe(id);
  });

  it("resolves a display name in any language", async () => {
    const { mcl, locator } = await setup();
    const context = { ...mcl, locator };
    const id = await createScope(mcl, locator, { en: "Make", fr: "Fabriquer" });

    const byEnglish = await resolveRef(context, "scflow.scope", "Make", "scope");
    const byFrench = await resolveRef(context, "scflow.scope", "Fabriquer", "scope");

    expect(byEnglish.id).toBe(id);
    expect(byFrench.id).toBe(id);
  });

  it("matches a name exactly, not as a substring or in another case", async () => {
    const { mcl, locator } = await setup();
    const context = { ...mcl, locator };
    await createScope(mcl, locator, { en: "Make" });

    await expect(resolveRef(context, "scflow.scope", "Mak", "scope")).rejects.toThrow(/not found/);
    await expect(resolveRef(context, "scflow.scope", "make", "scope")).rejects.toThrow(/not found/);
  });

  it("throws when nothing matches, naming the parameter", async () => {
    const { mcl, locator } = await setup();
    const context = { ...mcl, locator };

    await expect(resolveRef(context, "scflow.scope", "Ghost", "default_scope")).rejects.toThrow(
      /default_scope.*not found/,
    );
  });

  it("throws when several instances carry the name, listing their ids", async () => {
    const { mcl, locator } = await setup();
    const context = { ...mcl, locator };
    const first = await createScope(mcl, locator, { en: "Twin" });
    const second = await createScope(mcl, locator, { fr: "Twin" });

    const error = await resolveRef(context, "scflow.scope", "Twin", "scope").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/ambiguous/);
    expect((error as Error).message).toContain(first);
    expect((error as Error).message).toContain(second);
  });

  it("prefers an id over a name that equals it", async () => {
    const { mcl, locator } = await setup();
    const context = { ...mcl, locator };
    const id = await createScope(mcl, locator, { en: "Plain" });
    await createScope(mcl, locator, { en: id });

    const scope = await resolveRef(context, "scflow.scope", id, "scope");

    expect(scope.id).toBe(id);
  });
});

describe("toLocalized", () => {
  it("stores a plain string under en", () => {
    expect(toLocalized("Main warehouse")).toEqual({ en: "Main warehouse" });
  });

  it("keeps a localized map as it is", () => {
    expect(toLocalized({ en: "Warehouse", fr: "Entrepôt" })).toEqual({ en: "Warehouse", fr: "Entrepôt" });
  });

});

import { beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/testing.js";
import type { TransientObject } from "../src/types.js";
import { createDoc, expectCode, setup } from "./mapTestSupport.js";

/**
 * Filters on the entry of a map property — the property paths of the `filter`
 * part (`display_name.fr`) in the `core` dataset, and the Filters section of
 * `docs/commands.md`.
 */

let locator: string;

beforeEach(async () => {
  ({ locator } = await setup([
    { name: "title", type: "localized_string" },
    { name: "label", type: "string" },
  ]));
  await runCommand(
    locator,
    createDoc(
      { name: "plant", title: { en: "Plant", fr: "Usine" } },
      { name: "tree", title: { en: "Tree", fr: "Arbre", de: "Baum" } },
      { name: "rock", title: { en: "Rock" } },
      { name: "bare" },
    ),
  );
});

async function namesWhere(filters: TransientObject): Promise<string[]> {
  const result = await runCommand(locator, { kind: "query", schema: "doc", filters, result: { properties: [] } });
  return result.after.map((instance) => (instance as TransientObject).name as string).sort();
}

describe("a predicate on the entry of a map", () => {
  it("matches the instances whose entry for the key satisfies it", async () => {
    expect(await namesWhere({ "title.fr": "Usine" })).toEqual(["plant"]);
    expect(await namesWhere({ "title.en": { in: ["Plant", "Rock"] } })).toEqual(["plant", "rock"]);
    expect(await namesWhere({ "title.fr": { matches: "^[AU]" } })).toEqual(["plant", "tree"]);
    expect(await namesWhere({ "title.fr": { contains: "bre" } })).toEqual(["tree"]);
  });

  it("is satisfied by no instance without an entry for the key, ne included", async () => {
    expect(await namesWhere({ "title.fr": { ne: "Usine" } })).toEqual(["tree"]);
    expect(await namesWhere({ "title.de": { ne: "Werk" } })).toEqual(["tree"]);
    expect(await namesWhere({ "title.es": { ne: "x" } })).toEqual([]);
  });

  it("is negated by not, which then matches the instances without an entry", async () => {
    expect(await namesWhere({ not: { "title.fr": "Usine" } })).toEqual(["bare", "rock", "tree"]);
  });

  it("tells whether an entry exists with exists", async () => {
    expect(await namesWhere({ "title.fr": { exists: true } })).toEqual(["plant", "tree"]);
  });

  it("combines with other predicates through and and or", async () => {
    expect(await namesWhere({ and: [{ "title.en": { matches: "^T" } }, { "title.de": "Baum" }] })).toEqual(["tree"]);
    expect(await namesWhere({ or: [{ "title.fr": "Usine" }, { "title.en": "Rock" }] })).toEqual(["plant", "rock"]);
  });

  it("applies to update and delete like to query", async () => {
    await runCommand(locator, { kind: "update", schema: "doc", filters: { "title.fr": "Usine" }, input: [{ label: "found" }] });
    expect(await namesWhere({ label: "found" })).toEqual(["plant"]);

    await runCommand(locator, { kind: "delete", schema: "doc", filters: { "title.de": { exists: true } } });
    expect(await namesWhere({})).toEqual(["bare", "plant", "rock"]);
  });
});

describe("a predicate on the whole map", () => {
  it("tells whether the map has an entry with exists", async () => {
    expect(await namesWhere({ title: { exists: true } })).toEqual(["plant", "rock", "tree"]);
    expect(await namesWhere({ title: { exists: false } })).toEqual(["bare"]);
  });

  it("compares the entries whatever their order", async () => {
    expect(await namesWhere({ title: { eq: { fr: "Usine", en: "Plant" } } })).toEqual(["plant"]);
    expect(await namesWhere({ title: { ne: { en: "Rock" } } })).toEqual(["bare", "plant", "tree"]);
  });
});

describe("a property path that goes through a map", () => {
  it("is refused with unknown_property when the property is not declared, even without any instance", async () => {
    await expectCode(() => runCommand(locator, { kind: "query", schema: "doc", filters: { "titel.fr": "x" } }), "unknown_property");
  });

  it("is refused with unknown_property when it goes on after the key of an entry", async () => {
    await expectCode(() => runCommand(locator, { kind: "query", schema: "doc", filters: { "title.fr.x": "x" } }), "unknown_property");
  });

  it("is refused with unknown_property when it goes through a string", async () => {
    await expectCode(() => runCommand(locator, { kind: "query", schema: "doc", filters: { "label.fr": "x" } }), "unknown_property");
  });

  it("refuses an array used as a value on an entry, and an in operand that is not an array", async () => {
    await expectCode(() => runCommand(locator, { kind: "query", schema: "doc", filters: { "title.fr": ["Usine"] } }), "type_mismatch");
    await expectCode(() => runCommand(locator, { kind: "query", schema: "doc", filters: { "title.fr": { in: "Usine" } } }), "type_mismatch");
  });
});

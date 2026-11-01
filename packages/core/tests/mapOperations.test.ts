import { describe, expect, it } from "vitest";
import { runCommand } from "../src/index.js";
import type { TransientObject } from "../src/types.js";
import { createDoc, expectCode, propertyOf, setup, updateDoc } from "./mapTestSupport.js";

/**
 * Map operations `set` and `remove` on an `update` — "Map operations" and
 * *Exceptions* of the `command` part and the `command_examples` part in the
 * `core` dataset, and the Map operations section of `docs/commands.md`.
 */

const properties = [
  { name: "title", type: "localized_string" },
  { name: "label", type: "string" },
  { name: "count", type: "integer" },
];

describe("map operation: set", () => {
  it("replaces or adds the given entries and keeps the others, before and after carrying the old and the new map", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant", fr: "Plante" } }));

    const result = await runCommand(locator, updateDoc("a", { title: { set: { fr: "Usine", de: "Werk" } } }));

    expect((result.before[0] as TransientObject).title).toEqual({ en: "Plant", fr: "Plante" });
    expect((result.after[0] as TransientObject).title).toEqual({ en: "Plant", fr: "Usine", de: "Werk" });
    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant", fr: "Usine", de: "Werk" });
  });

  it("starts from the empty map when the stored value is null", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a" }));

    await runCommand(locator, updateDoc("a", { title: { set: { en: "Plant" } } }));

    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
  });

  it("applies the operation to the map of each matched instance", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "A" } }, { name: "b", title: { en: "B", fr: "Bé" } }));

    await runCommand(locator, { kind: "update", schema: "doc", input: [{ title: { set: { de: "X" } } }] });

    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "A", de: "X" });
    expect(await propertyOf(locator, "b", "title")).toEqual({ en: "B", fr: "Bé", de: "X" });
  });

  it("validates the keys, the values and the constraints on the resulting map", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string", max_length: 1 }]);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" } }));

    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: { FR: "Usine" } } })), "constraint_violation");
    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: { fr: 5 } } })), "constraint_violation");
    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: { fr: "Usine" } } })), "constraint_violation");
    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
  });

  it("refuses an operand that is not a mapping with invalid_map_operation", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" } }));

    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: "fr" } })), "invalid_map_operation");
    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: ["fr"] } })), "invalid_map_operation");
    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: null } })), "invalid_map_operation");
  });
});

describe("map operation: remove", () => {
  it("removes the entries of the given keys and keeps the others", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant", fr: "Usine", de: "Werk" } }));

    const result = await runCommand(locator, updateDoc("a", { title: { remove: ["fr", "de"] } }));

    expect((result.before[0] as TransientObject).title).toEqual({ en: "Plant", fr: "Usine", de: "Werk" });
    expect((result.after[0] as TransientObject).title).toEqual({ en: "Plant" });
    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
  });

  it("ignores a key that has no entry", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" } }));

    await runCommand(locator, updateDoc("a", { title: { remove: ["fr"] } }));

    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
  });

  it("checks the constraints on the resulting map", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string", min_length: 1 }]);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" } }));

    await expectCode(() => runCommand(locator, updateDoc("a", { title: { remove: ["en"] } })), "constraint_violation");
    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
  });

  it("refuses an operand that is not an array of keys with invalid_map_operation", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" } }));

    await expectCode(() => runCommand(locator, updateDoc("a", { title: { remove: "en" } })), "invalid_map_operation");
    await expectCode(() => runCommand(locator, updateDoc("a", { title: { remove: { en: true } } })), "invalid_map_operation");
    await expectCode(() => runCommand(locator, updateDoc("a", { title: { remove: [1] } })), "invalid_map_operation");
  });
});

describe("a mapping that is not a map operation", () => {
  it("is a literal map when it has several keys, even with set among them", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" } }));

    await expectCode(() => runCommand(locator, updateDoc("a", { title: { set: { fr: "Usine" }, remove: ["en"] } })), "constraint_violation");
    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
  });

  it("is a literal map when set or remove is a valid key of the key type", async () => {
    const { locator } = await setup([{ name: "tags", type: "{identifier: string}" }]);
    await runCommand(locator, createDoc({ name: "a" }));

    await runCommand(locator, updateDoc("a", { tags: { set: "x" } }));
    expect(await propertyOf(locator, "a", "tags")).toEqual({ set: "x" });

    await runCommand(locator, updateDoc("a", { tags: { remove: "y" } }));
    expect(await propertyOf(locator, "a", "tags")).toEqual({ remove: "y" });
  });

  it("refuses a map operation inside a create", async () => {
    const { locator } = await setup(properties);

    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { set: { en: "Plant" } } })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { remove: ["en"] } })), "constraint_violation");
  });

  it("is refused on a property that is not a map", async () => {
    const { locator } = await setup(properties);
    await runCommand(locator, createDoc({ name: "a", label: "L", count: 3 }));

    await expectCode(() => runCommand(locator, updateDoc("a", { count: { set: { en: "x" } } })), "constraint_violation");
    await expectCode(() => runCommand(locator, updateDoc("a", { label: { set: { en: "x" } } })), "unknown_text_operation");
  });
});

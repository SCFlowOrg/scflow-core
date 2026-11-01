import { describe, expect, it } from "vitest";
import { runCommand } from "../src/index.js";
import { processSchemaDescription, resolveType } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { NormalizedSchema } from "../src/types.js";
import { createDoc, expectCode, noScalarTypes, propertyOf, setup, updateDoc } from "./mapTestSupport.js";

/**
 * Map types `{K: V}` and the built-in `localized_string`, `localized_markdown`
 * and `language_code` — the "Map types" paragraph of the `property` part, the
 * `internationalization` part and the scalar types of `scalar_types` in the
 * `core` dataset, and the Map types section of `docs/authoring.md`.
 *
 * Runs through the public API against the in-memory format of
 * `mapTestSupport.ts`, on a `doc` schema whose properties each test declares.
 */

describe("resolveType on a map type", () => {
  it("resolves {K: V} to a map of the key and value scalar types", () => {
    const resolved = resolveType("{language_code: string}", noScalarTypes);

    expect(resolved.kind).toBe("map");
    if (resolved.kind !== "map") return;
    expect(resolved.key.base).toBe("string");
    expect(resolved.value.base).toBe("string");
  });

  it("resolves localized_string like {language_code: string}", () => {
    expect(resolveType("localized_string", noScalarTypes)).toEqual(resolveType("{language_code: string}", noScalarTypes));
  });

  it("resolves localized_markdown to a map whose values are markdown", () => {
    const resolved = resolveType("localized_markdown", noScalarTypes);

    expect(resolved.kind).toBe("map");
    if (resolved.kind !== "map") return;
    expect(resolved.value.constraints.markdown).toBe(true);
    expect(resolved).toEqual(resolveType("{language_code: markdown}", noScalarTypes));
  });

  it("gives language_code its pattern", () => {
    const resolved = resolveType("language_code", noScalarTypes);

    expect(resolved.kind).toBe("scalar");
    if (resolved.kind !== "scalar") return;
    expect(resolved.base).toBe("string");
    expect(new RegExp(resolved.constraints.pattern as string).test("pt-BR")).toBe(true);
    expect(new RegExp(resolved.constraints.pattern as string).test("english")).toBe(false);
  });

  it("refuses a key that is not a string-based scalar type, a value that is not a scalar type and a malformed notation", async () => {
    const other = processSchemaDescription({ name: "other", shared_by_name: true, properties: [{ name: "name", type: "identifier" }] }, noScalarTypes);
    const ctx: TypeResolutionContext = { resolveSchema: (n) => (n === "other" ? (other as NormalizedSchema) : undefined), resolveScalarType: () => undefined };

    await expectCode(() => resolveType("{integer: string}", ctx), "constraint_violation");
    await expectCode(() => resolveType("{language_code: other}", ctx), "constraint_violation");
    await expectCode(() => resolveType("{language_code: [string]}", ctx), "constraint_violation");
    await expectCode(() => resolveType("{language_code: {language_code: string}}", ctx), "constraint_violation");
    await expectCode(() => resolveType("{language_code}", ctx), "constraint_violation");
    await expectCode(() => resolveType("{language_code: string", ctx), "constraint_violation");
    await expectCode(() => resolveType("{language_code: nothing}", ctx), "unknown_scalar_type");
  });
});

describe("a property of a map type in a schema", () => {
  it.each([
    ["is_array", { is_array: true }],
    ["a default_value", { default_value: "x" }],
    ["a null_value", { null_value: "x" }],
    ["is_content", { is_content: true }],
    ["is_folder", { is_folder: true }],
  ])("refuses %s on a map", async (_label, extra) => {
    await expectCode(
      () => processSchemaDescription({ name: "s", properties: [{ name: "title", type: "{language_code: string}", ...extra }] }, noScalarTypes),
      "constraint_violation",
    );
  });

  it("refuses the array sugar on a map type", async () => {
    await expectCode(
      () => processSchemaDescription({ name: "s", properties: [{ name: "title", type: "[{language_code: string}]" }] }, noScalarTypes),
      "constraint_violation",
    );
  });

  it("accepts localized_string and localized_markdown", () => {
    const schema = processSchemaDescription(
      { name: "s", properties: [{ name: "title", type: "localized_string", min_length: 1 }, { name: "body", type: "localized_markdown" }] },
      noScalarTypes,
    );

    expect(schema.properties.map((p) => p.type)).toEqual(["localized_string", "localized_markdown"]);
  });
});

describe("the value of a map property", () => {
  it("stores the entries given on create", async () => {
    const { locator } = await setup([{ name: "title", type: "{language_code: string}" }]);

    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant", fr: "Usine" } }));

    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant", fr: "Usine" });
  });

  it("is {} when the property is not given, and when it is null", async () => {
    const { locator } = await setup([{ name: "title", type: "{language_code: string}" }]);

    await runCommand(locator, createDoc({ name: "a" }, { name: "b", title: null }));

    expect(await propertyOf(locator, "a", "title")).toEqual({});
    expect(await propertyOf(locator, "b", "title")).toEqual({});
  });

  it("is held the same through localized_string and localized_markdown", async () => {
    const { locator } = await setup([
      { name: "title", type: "localized_string" },
      { name: "body", type: "localized_markdown" },
    ]);

    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant" }, body: { fr: "# Usine" } }));

    expect(await propertyOf(locator, "a", "title")).toEqual({ en: "Plant" });
    expect(await propertyOf(locator, "a", "body")).toEqual({ fr: "# Usine" });
  });

  it("is replaced as a whole by an update that gives a literal map", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string" }]);
    await runCommand(locator, createDoc({ name: "a", title: { en: "Plant", fr: "Usine" } }));

    await runCommand(locator, updateDoc("a", { title: { de: "Werk" } }));

    expect(await propertyOf(locator, "a", "title")).toEqual({ de: "Werk" });
  });

  it("refuses a key that breaks the key type", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string" }]);

    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { english: "Plant" } })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { FR: "Usine" } })), "constraint_violation");
  });

  it("refuses a value that is not of the value type", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string" }]);

    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { en: 5 } })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { en: null } })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { en: ["Plant"] } })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { en: { x: "y" } } })), "constraint_violation");
  });

  it("refuses a value that is not a mapping", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string" }]);

    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: "Plant" })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: ["Plant"] })), "constraint_violation");
  });

  it("counts entries for min_length and max_length", async () => {
    const { locator } = await setup([{ name: "title", type: "localized_string", min_length: 1, max_length: 2 }]);

    await expectCode(() => runCommand(locator, createDoc({ name: "a" })), "constraint_violation");
    await expectCode(() => runCommand(locator, createDoc({ name: "a", title: { en: "A", fr: "B", de: "C" } })), "constraint_violation");
    await runCommand(locator, createDoc({ name: "a", title: { en: "A" } }, { name: "b", title: { en: "A", fr: "B" } }));

    expect(await propertyOf(locator, "b", "title")).toEqual({ en: "A", fr: "B" });
  });
});

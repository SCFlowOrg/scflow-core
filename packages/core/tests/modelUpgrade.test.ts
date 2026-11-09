import { describe, expect, it } from "vitest";
import { applyInverseRelations, runSchemaCommand } from "../src/modelUpgrade.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

function fakeImpl(): PersistenceInterface {
  return {
    name: "fake",
    datasetExists: async () => true,
    createDataset: async () => ({}),
    getDataset: async () => ({}),
    updateDataset: async (_rest, patch) => patch,
    deleteDataset: async () => {},
    getInstance: async () => null,
    listInstances: async () => [],
    putInstance: async () => {},
    deleteInstance: async () => {},
  };
}

function ctxWith(schemas: Map<string, NormalizedSchema>): TypeResolutionContext {
  return {
    resolveSchema: (name) => schemas.get(name),
    resolveScalarType: () => undefined,
  };
}

describe("applyInverseRelations — extends", () => {
  /**
   * Schema Processing flattens `extends`, so a schema extending one that
   * declares a relation carries that relation among its own properties. The
   * inverse belongs to the schema declaring it: generating it again for each
   * extending schema retypes the target's property to whichever was ingested
   * last, and every other one's instances stop being valid targets. See
   * packages/core/docs/spec/model-command-language.md#schema-processing's "Virtual relations".
   */
  it("leaves the generated inverse typed to the declaring schema when an extending schema is applied", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const section = processSchemaDescription({ name: "section", properties: [{ name: "name", type: "identifier" }] }, ctxWith(schemas));
    schemas.set("section", section);

    const part = processSchemaDescription(
      {
        name: "part",
        properties: [
          { name: "name", type: "identifier" },
          { name: "section", type: "section", inverse_name: "parts", inverse_is_array: true },
        ],
      },
      ctxWith(schemas),
    );
    schemas.set("part", part);
    await applyInverseRelations(fakeImpl(), "test:rest", schemas, part);

    for (const kind of ["part_concept", "part_definition"]) {
      const extending = processSchemaDescription({ name: kind, extends: "part" }, ctxWith(schemas));
      schemas.set(kind, extending);
      await applyInverseRelations(fakeImpl(), "test:rest", schemas, extending);
    }

    const parts = schemas.get("section")?.properties.find((p) => p.name === "parts");
    expect(parts).toMatchObject({ name: "parts", type: "part", constraints: { is_array: true, __generated: true } });
  });

  it("still generates the inverse of a relation an extending schema declares itself", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const label = processSchemaDescription({ name: "label", properties: [{ name: "name", type: "identifier" }] }, ctxWith(schemas));
    schemas.set("label", label);
    const part = processSchemaDescription({ name: "part", properties: [{ name: "name", type: "identifier" }] }, ctxWith(schemas));
    schemas.set("part", part);

    const tagged = processSchemaDescription(
      { name: "tagged_part", extends: "part", properties: [{ name: "label", type: "label", inverse_name: "tagged_parts", inverse_is_array: true }] },
      ctxWith(schemas),
    );
    schemas.set("tagged_part", tagged);
    await applyInverseRelations(fakeImpl(), "test:rest", schemas, tagged);

    expect(schemas.get("label")?.properties.find((p) => p.name === "tagged_parts")).toMatchObject({ type: "tagged_part" });
  });
});

/** A persistence stub that keeps the stored instances of every schema, so a command reads back what it wrote. */
function storeImpl(): PersistenceInterface {
  const stores = new Map<string, Map<Key, TransientValue>>();
  const store = (schema: string): Map<Key, TransientValue> => {
    let s = stores.get(schema);
    if (!s) {
      s = new Map();
      stores.set(schema, s);
    }
    return s;
  };
  return {
    ...fakeImpl(),
    getInstance: async (_rest, schema, key) => store(schema).get(key) ?? null,
    listInstances: async (_rest, schema) => [...store(schema).values()],
    putInstance: async (_rest, schema, key, instance) => {
      store(schema).set(key, instance);
    },
    deleteInstance: async (_rest, schema, key) => {
      store(schema).delete(key);
    },
  };
}

describe("runSchemaCommand — schemas of one create command", () => {
  const a = { name: "a", properties: [{ name: "to_b", type: "b", inverse_name: "as", inverse_is_array: true }] };
  const b = { name: "b", properties: [{ name: "to_a", type: "a", inverse_name: "bs", inverse_is_array: true }] };

  function setup() {
    const schemas = new Map<string, NormalizedSchema>();
    const impl = storeImpl();
    const resolvers = { ctx: ctxWith(schemas), schemas, scalarTypes: new Map() };
    return { schemas, impl, resolvers };
  }

  it.each([
    ["a before b", [a, b]],
    ["b before a", [b, a]],
  ])("creates two schemas that reference each other through inverse relations, %s", async (_order, input) => {
    const { schemas, impl, resolvers } = setup();
    const result = await runSchemaCommand(impl, "test:rest", { kind: "create", schema: "schema", input }, resolvers);

    expect(schemas.get("a")?.properties.find((p) => p.name === "bs")).toMatchObject({ type: "b", constraints: { is_array: true, __generated: true } });
    expect(schemas.get("b")?.properties.find((p) => p.name === "as")).toMatchObject({ type: "a", constraints: { is_array: true, __generated: true } });

    const stored = (await impl.getInstance("test:rest", "schema", "a", {})) as unknown as NormalizedSchema;
    expect(stored.properties.map((p) => p.name)).toContain("bs");

    const names = result.after.map((s) => (s as unknown as NormalizedSchema).name);
    expect(names).toEqual(input.map((s) => s.name));
    for (const created of result.after as unknown as NormalizedSchema[]) {
      expect(created.properties.map((p) => p.name)).toContain(created.name === "a" ? "bs" : "as");
    }
  });

  it("generates the inverse of a relation that targets its own schema", async () => {
    const { schemas, impl, resolvers } = setup();
    const node = { name: "node", properties: [{ name: "parent", type: "node", inverse_name: "children", inverse_is_array: true }] };
    await runSchemaCommand(impl, "test:rest", { kind: "create", schema: "schema", input: [node] }, resolvers);

    expect(schemas.get("node")?.properties.find((p) => p.name === "children")).toMatchObject({ type: "node", constraints: { __generated: true } });
  });

  it("refuses an inverse relation whose target is in neither the command nor the model", async () => {
    const { impl, resolvers } = setup();
    await expect(runSchemaCommand(impl, "test:rest", { kind: "create", schema: "schema", input: [a] }, resolvers)).rejects.toThrow(
      'targets unknown schema "b"',
    );
  });

  it("still resolves an inverse relation to a schema created by an earlier command", async () => {
    const { schemas, impl, resolvers } = setup();
    await runSchemaCommand(impl, "test:rest", { kind: "create", schema: "schema", input: [{ name: "b", properties: [] }] }, resolvers);
    await runSchemaCommand(impl, "test:rest", { kind: "create", schema: "schema", input: [a] }, resolvers);

    expect(schemas.get("b")?.properties.find((p) => p.name === "as")).toMatchObject({ type: "a", constraints: { __generated: true } });
  });
});

describe("runSchemaCommand — schemas of one update command", () => {
  const patches: Record<string, TransientValue> = {
    a: { properties: [{ name: "to_b", type: "b", inverse_name: "as", inverse_is_array: true }] },
    b: { properties: [{ name: "to_a", type: "a", inverse_name: "bs", inverse_is_array: true }] },
  };

  it.each([
    ["a before b", ["a", "b"]],
    ["b before a", ["b", "a"]],
  ])("keeps the inverse properties that the schemas of the command generate on each other, %s", async (_order, order) => {
    const schemas = new Map<string, NormalizedSchema>();
    const impl = storeImpl();
    const resolvers = { ctx: ctxWith(schemas), schemas, scalarTypes: new Map() };
    await runSchemaCommand(impl, "test:rest", { kind: "create", schema: "schema", input: order.map((name) => ({ name, properties: [] })) }, resolvers);

    await runSchemaCommand(impl, "test:rest", { kind: "update", schema: "schema", input: order.map((name) => patches[name]) }, resolvers);

    for (const [name, declared, generated] of [
      ["a", "to_b", "bs"],
      ["b", "to_a", "as"],
    ]) {
      const stored = (await impl.getInstance("test:rest", "schema", name, {})) as unknown as NormalizedSchema;
      expect(stored.properties.map((p) => p.name)).toEqual(expect.arrayContaining([declared, generated]));
    }
  });
});

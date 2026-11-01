import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { registerPersistentFormat, runCommand } from "../src/index.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Up-front filter check — document part `filter` (*Arrays as values*,
 * *Exceptions*) in the `core` dataset.
 *
 * Runs through the public API against a small in-memory format, on a `task`
 * schema carrying a `string` property, a `string` array property (`tags`) and
 * a relation (`assignee`) to a `person` schema carrying a `string` property.
 */

let formatCounter = 0;

function fakeFormat(): PersistenceInterface {
  const name = `test-filter-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();

  function getState(rest: string) {
    const state = datasets.get(rest);
    if (!state) throw new ModelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return state;
  }

  function getStore(rest: string, schema: string): Map<Key, TransientValue> {
    const state = getState(rest);
    let store = state.stores.get(schema);
    if (!store) {
      store = new Map();
      state.stores.set(schema, store);
    }
    return store;
  }

  return {
    name,
    supportsTransactions: true,
    areaOf: (rest) => rest,
    builtinRestFor: () => "no-builtin",

    async datasetExists(rest) {
      return datasets.has(rest);
    },
    async createDataset(rest, dsName) {
      const now = new Date().toISOString();
      const info: TransientObject = {
        name: dsName,
        model_major_version: 0,
        model_minor_version: 0,
        data_major_version: 0,
        data_minor_version: 0,
        created_at: now,
        updated_at: now,
      };
      datasets.set(rest, { info, stores: new Map() });
      return info;
    },
    async getDataset(rest) {
      return getState(rest).info;
    },
    async updateDataset(rest, patch) {
      const state = getState(rest);
      Object.assign(state.info, patch as object);
      return state.info;
    },
    async deleteDataset(rest) {
      getState(rest);
      datasets.delete(rest);
    },
    async getInstance(rest, schema, key) {
      const value = getStore(rest, schema).get(key);
      return value === undefined ? null : value;
    },
    async listInstances(rest, schema) {
      return [...getStore(rest, schema).values()];
    },
    async putInstance(rest, schema, key, instance) {
      getStore(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      getStore(rest, schema).delete(key);
    },
  };
}

/** A fresh dataset holding the `person` and `task` schemas, seeded directly into the store. */
async function setup(): Promise<{ impl: PersistenceInterface; locator: string }> {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const person = processSchemaDescription(
    {
      name: "person",
      shared_by_name: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "email", type: "string" },
      ],
    },
    ctx,
  );
  schemas.set("person", person);
  const task = processSchemaDescription(
    {
      name: "task",
      shared_by_name: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "label", type: "string" },
        { name: "tags", type: "string", is_array: true },
        { name: "assignee", type: "person" },
      ],
    },
    ctx,
  );
  schemas.set("task", task);
  await impl.putInstance("d1", "schema", "person", person as unknown as TransientValue, {});
  await impl.putInstance("d1", "schema", "task", task as unknown as TransientValue, {});
  return { impl, locator: `${impl.name}:d1` };
}

/** `setup()` plus two persons and three tasks. */
async function seeded(): Promise<{ impl: PersistenceInterface; locator: string }> {
  const s = await setup();
  await runCommand(s.locator, { kind: "create", schema: "person", input: [{ name: "alice" }, { name: "bob" }] });
  await runCommand(s.locator, {
    kind: "create",
    schema: "task",
    input: [
      { name: "a", label: "A", tags: ["x", "y"], assignee: "alice" },
      { name: "b", label: "B", tags: ["x"], assignee: "bob" },
      { name: "c", label: "C", tags: [] },
    ],
  });
  return s;
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<ModelError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe(code);
    return err as ModelError;
  }
  return expect.fail(`expected a ${code}`);
}

const query = (locator: string, filters: TransientObject) => runCommand(locator, { kind: "query", schema: "task", filters });

const names = (result: { after: TransientValue[] }) => result.after.map((i) => (i as TransientObject).name).sort();

describe("filter: an array used as a value on a property that is not an array", () => {
  it("refuses a bare array with type_mismatch, the message pointing at `in`", async () => {
    const { locator } = await seeded();
    const err = await expectCode(() => query(locator, { name: ["a", "b"] }), "type_mismatch");
    expect(err.message).toContain("in");
    expect(err.message).toContain("name");
  });

  it("refuses it on a schema holding no instance", async () => {
    const { locator } = await setup();
    await expectCode(() => query(locator, { label: ["a", "b"] }), "type_mismatch");
  });

  it("refuses an array operand of eq and of ne", async () => {
    const { locator } = await seeded();
    await expectCode(() => query(locator, { name: { eq: ["a"] } }), "type_mismatch");
    await expectCode(() => query(locator, { name: { ne: ["a"] } }), "type_mismatch");
  });

  it("refuses it nested in and, or and not", async () => {
    const { locator } = await seeded();
    await expectCode(() => query(locator, { and: [{ label: "A" }, { name: ["a"] }] }), "type_mismatch");
    await expectCode(() => query(locator, { or: [{ label: "A" }, { name: ["a"] }] }), "type_mismatch");
    await expectCode(() => query(locator, { not: { name: ["a"] } }), "type_mismatch");
  });

  it("refuses it across a relation", async () => {
    const { locator } = await seeded();
    await expectCode(() => query(locator, { "assignee.name": ["alice"] }), "type_mismatch");
  });

  it("refuses it on update and delete, leaving the dataset unchanged", async () => {
    const { locator } = await seeded();
    await expectCode(
      () => runCommand(locator, { kind: "update", schema: "task", filters: { name: ["a"] }, input: [{ label: "Z" }] }),
      "type_mismatch",
    );
    await expectCode(() => runCommand(locator, { kind: "delete", schema: "task", filters: { name: ["a"] } }), "type_mismatch");
    const all = await runCommand(locator, { kind: "query", schema: "task" });
    expect(names(all)).toEqual(["a", "b", "c"]);
    expect(all.after.map((i) => (i as TransientObject).label).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("filter: the operand of in", () => {
  it("refuses an operand that is not an array with type_mismatch", async () => {
    const { locator } = await seeded();
    await expectCode(() => query(locator, { name: { in: "a" } }), "type_mismatch");
  });

  it("matches as before with an array operand", async () => {
    const { locator } = await seeded();
    expect(names(await query(locator, { name: { in: ["a", "b"] } }))).toEqual(["a", "b"]);
  });
});

describe("filter: an array used as a value on an array property", () => {
  it("compares the whole array, without error", async () => {
    const { locator } = await seeded();
    expect(names(await query(locator, { tags: ["x", "y"] }))).toEqual(["a"]);
  });
});

describe("filter: shape", () => {
  const raw = (locator: string, kind: string, filters: unknown, extra: TransientObject = {}) =>
    runCommand(locator, { kind, schema: "task", filters, ...extra } as never);

  it("refuses a filter given as an array with invalid_filter, not unknown_property on \"0\"", async () => {
    const { locator } = await seeded();
    const err = await expectCode(() => raw(locator, "query", [{ name: "a" }]), "invalid_filter");
    expect(err.message).toContain("array");
    expect(err.message).toContain("and");
  });

  it("refuses a filter given as a string", async () => {
    const { locator } = await seeded();
    await expectCode(() => raw(locator, "query", '{"name": "a"}'), "invalid_filter");
    await expectCode(() => raw(locator, "query", ""), "invalid_filter");
  });

  it("refuses it on a schema holding no instance", async () => {
    const { locator } = await setup();
    await expectCode(() => raw(locator, "query", [{ name: "a" }]), "invalid_filter");
  });

  it("refuses and/or that are not arrays, and a not that is not a mapping", async () => {
    const { locator } = await seeded();
    await expectCode(() => raw(locator, "query", { and: { name: "a" } }), "invalid_filter");
    await expectCode(() => raw(locator, "query", { or: { name: "a" } }), "invalid_filter");
    await expectCode(() => raw(locator, "query", { not: [{ name: "a" }] }), "invalid_filter");
  });

  it("refuses a nested element that is not a mapping", async () => {
    const { locator } = await seeded();
    await expectCode(() => raw(locator, "query", { and: [{ label: "A" }, [{ name: "a" }]] }), "invalid_filter");
    await expectCode(() => raw(locator, "query", { or: ["name"] }), "invalid_filter");
  });

  it("refuses it on update and delete, leaving the dataset unchanged", async () => {
    const { locator } = await seeded();
    await expectCode(() => raw(locator, "update", [{ name: "a" }], { input: [{ label: "Z" }] }), "invalid_filter");
    await expectCode(() => raw(locator, "delete", [{ name: "a" }]), "invalid_filter");
    const all = await runCommand(locator, { kind: "query", schema: "task" });
    expect(names(all)).toEqual(["a", "b", "c"]);
    expect(all.after.map((i) => (i as TransientObject).label).sort()).toEqual(["A", "B", "C"]);
  });

  it("matches as before with well-formed and, or and not", async () => {
    const { locator } = await seeded();
    expect(names(await query(locator, { and: [{ tags: { contains: "x" } }, { not: { name: "a" } }] }))).toEqual(["b"]);
    expect(names(await query(locator, { or: [{ name: "a" }, { name: "c" }] }))).toEqual(["a", "c"]);
  });
});

describe("filter: property paths checked before any instance is read", () => {
  it("raises unknown_property on a schema holding no instance", async () => {
    const { locator } = await setup();
    await expectCode(() => query(locator, { nope: "a" }), "unknown_property");
  });
});

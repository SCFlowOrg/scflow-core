import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { checkUpgrade, createUpgradeLocator, registerPersistentFormat, runCommand } from "../src/testing.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedScalarType, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * The `is_set` property constraint — parts `property_constraints` (*Sets*) and
 * `filter` (*Sets*) of the document `model` in the `core` dataset.
 *
 * Declaration tests call schema processing directly. The others run through the
 * public API against a small in-memory transactional format, on an `item`
 * schema holding sets of the enum scalar type `color` (`red`, `green`, `blue`,
 * in that declaration order) and a plain `tags` array, and a `strict` schema
 * whose set has a `min_length`.
 */

const COLORS = ["red", "green", "blue"];

const color: NormalizedScalarType = { name: "color", extends: "string", constraints: { enum: COLORS } };

function ctxWith(schemas: Record<string, NormalizedSchema> = {}): TypeResolutionContext {
  return { resolveSchema: (name) => schemas[name], resolveScalarType: (name) => (name === "color" ? color : undefined) };
}

function expectConstraintViolation(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected a constraint_violation");
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("constraint_violation");
  }
}

describe("is_set — declaration", () => {
  it("accepts it on a property typed with an enum scalar type, and the processed property is also an array", () => {
    const schema = processSchemaDescription({ name: "item", properties: [{ name: "colors", type: "color", is_set: true }] }, ctxWith());
    const prop = schema.properties.find((p) => p.name === "colors");
    expect(prop?.constraints.is_set).toBe(true);
    expect(prop?.constraints.is_array).toBe(true);
  });

  it("accepts it on a property carrying its own enum", () => {
    const schema = processSchemaDescription(
      { name: "item", properties: [{ name: "kinds", type: "string", enum: ["a", "b"], is_set: true }] },
      ctxWith(),
    );
    expect(schema.properties.find((p) => p.name === "kinds")?.constraints.is_array).toBe(true);
  });

  it("accepts is_set together with is_array and with the [type] notation", () => {
    const schema = processSchemaDescription(
      {
        name: "item",
        properties: [
          { name: "both", type: "color", is_array: true, is_set: true },
          { name: "bracketed", type: "[color]", is_set: true },
        ],
      },
      ctxWith(),
    );
    expect(schema.properties.map((p) => [p.constraints.is_set, p.constraints.is_array])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("does not make a property an array when is_set is false", () => {
    const schema = processSchemaDescription({ name: "item", properties: [{ name: "one", type: "color", is_set: false }] }, ctxWith());
    expect(schema.properties.find((p) => p.name === "one")?.constraints.is_array).not.toBe(true);
  });

  it("rejects it on a scalar type without enum with constraint_violation", () => {
    expectConstraintViolation(() => processSchemaDescription({ name: "item", properties: [{ name: "words", type: "string", is_set: true }] }, ctxWith()));
  });

  it("rejects it on a relation with constraint_violation", () => {
    const bucket: NormalizedSchema = { name: "bucket", description: "", content: "", extends: null, cannot_be_extended: false, properties: [], constraints: {} };
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "item", properties: [{ name: "bucket", type: "bucket", is_set: true }] }, ctxWith({ bucket })),
    );
  });

  it("rejects it on a map with constraint_violation", () => {
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "item", properties: [{ name: "names", type: "{string: string}", is_set: true }] }, ctxWith()),
    );
  });
});

// ---------------------------------------------------------------------------
// Through the public API
// ---------------------------------------------------------------------------

let formatCounter = 0;

function fakeFormat(): PersistenceInterface {
  const name = `test-set-fmt-${++formatCounter}`;
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

const itemDescription = (properties: TransientObject[]): TransientObject => ({
  name: "item",
  shared_by_name: true,
  properties: [{ name: "name", type: "identifier" }, ...properties],
});

const SET_PROPERTIES: TransientObject[] = [
  { name: "colors", type: "color", is_set: true },
  { name: "pair", type: "color", is_set: true, max_length: 2 },
  { name: "kinds", type: "string", enum: ["a", "b", "c"], is_set: true },
  { name: "tags", type: "string", is_array: true },
];

/** A fresh dataset holding the scalar type `color` and the `item` and `strict` schemas, seeded directly into the store. */
async function setup(itemProperties: TransientObject[] = SET_PROPERTIES): Promise<{ impl: PersistenceInterface; locator: string }> {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  await impl.putInstance("d1", "scalar_type", "color", color as unknown as TransientValue, {});
  const ctx = ctxWith();
  const item = processSchemaDescription(itemDescription(itemProperties), ctx);
  const strict = processSchemaDescription(
    {
      name: "strict",
      shared_by_name: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "colors", type: "color", is_set: true, min_length: 1 },
      ],
    },
    ctx,
  );
  await impl.putInstance("d1", "schema", "item", item as unknown as TransientValue, {});
  await impl.putInstance("d1", "schema", "strict", strict as unknown as TransientValue, {});
  return { impl, locator: `${impl.name}:d1` };
}

async function expectConstraintViolationAsync(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.fail("expected a constraint_violation");
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("constraint_violation");
  }
}

const createItem = (locator: string, ...items: TransientObject[]) => runCommand(locator, { kind: "create", schema: "item", input: items });

const updateItem = (locator: string, name: string, patch: TransientObject) =>
  runCommand(locator, { kind: "update", schema: "item", filters: { name }, input: [patch] });

const queryItems = (locator: string, filters: TransientObject = {}) => runCommand(locator, { kind: "query", schema: "item", filters });

const names = (result: { after: TransientValue[] }) => result.after.map((i) => (i as TransientObject).name).sort();

async function valueOf(locator: string, name: string, property: string): Promise<TransientValue> {
  const result = await queryItems(locator, { name });
  return (result.after[0] as TransientObject)[property];
}

describe("is_set — writes", () => {
  it("defaults to the empty set", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a" });
    expect(await valueOf(locator, "a", "colors")).toEqual([]);
  });

  it("stores the entries in the declaration order of the enum, whatever the order of the input", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", colors: ["blue", "red", "green"], kinds: ["c", "a"] });
    expect(await valueOf(locator, "a", "colors")).toEqual(["red", "green", "blue"]);
    expect(await valueOf(locator, "a", "kinds")).toEqual(["a", "c"]);
  });

  it("refuses a duplicate on create with constraint_violation", async () => {
    const { locator } = await setup();
    await expectConstraintViolationAsync(() => createItem(locator, { name: "a", colors: ["red", "red"] }));
    expect(names(await queryItems(locator))).toEqual([]);
  });

  it("refuses a duplicate on update with constraint_violation and leaves the stored value unchanged", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", colors: ["red"] });
    await expectConstraintViolationAsync(() => updateItem(locator, "a", { colors: ["green", "blue", "green"] }));
    expect(await valueOf(locator, "a", "colors")).toEqual(["red"]);
  });

  it("refuses an entry outside the enum with constraint_violation", async () => {
    const { locator } = await setup();
    await expectConstraintViolationAsync(() => createItem(locator, { name: "a", colors: ["red", "purple"] }));
    await expectConstraintViolationAsync(() => createItem(locator, { name: "b", kinds: ["d"] }));
  });

  it("replaces the whole set on update, in canonical order", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", colors: ["red", "green"] });
    const result = await updateItem(locator, "a", { colors: ["blue", "green"] });
    expect((result.before[0] as TransientObject).colors).toEqual(["red", "green"]);
    expect((result.after[0] as TransientObject).colors).toEqual(["green", "blue"]);
    expect(await valueOf(locator, "a", "colors")).toEqual(["green", "blue"]);
  });

  it("leaves a plain array unordered and free of the set rules", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", tags: ["y", "x", "y"] });
    expect(await valueOf(locator, "a", "tags")).toEqual(["y", "x", "y"]);
  });

  it("counts entries for max_length", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", pair: ["red", "blue"] });
    await expectConstraintViolationAsync(() => createItem(locator, { name: "b", pair: ["red", "green", "blue"] }));
  });

  it("counts distinct entries for min_length", async () => {
    const { locator } = await setup();
    await runCommand(locator, { kind: "create", schema: "strict", input: [{ name: "ok", colors: ["red"] }] });
    await expectConstraintViolationAsync(() => runCommand(locator, { kind: "create", schema: "strict", input: [{ name: "empty" }] }));
    await expectConstraintViolationAsync(() => runCommand(locator, { kind: "create", schema: "strict", input: [{ name: "dup", colors: ["red", "red"] }] }));
  });
});

describe("is_set — filters", () => {
  async function seeded() {
    const s = await setup();
    await createItem(
      s.locator,
      { name: "a", colors: ["red", "blue"], tags: ["x", "y"] },
      { name: "b", colors: ["red"] },
      { name: "c", colors: ["green", "blue", "red"] },
      { name: "d" },
    );
    return s;
  }

  it("compares a bare array without regard to order", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { colors: ["blue", "red"] }))).toEqual(["a"]);
    expect(names(await queryItems(locator, { colors: ["red", "blue"] }))).toEqual(["a"]);
  });

  it("compares the operand of eq and ne without regard to order", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { colors: { eq: ["blue", "red"] } }))).toEqual(["a"]);
    expect(names(await queryItems(locator, { colors: { ne: ["blue", "red"] } }))).toEqual(["b", "c", "d"]);
  });

  it("does not match a subset or a superset on equality", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { colors: ["red", "green"] }))).toEqual([]);
    expect(names(await queryItems(locator, { colors: [] }))).toEqual(["d"]);
  });

  it("keeps contains and exists as on any array", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { colors: { contains: "green" } }))).toEqual(["c"]);
    expect(names(await queryItems(locator, { colors: { exists: true } }))).toEqual(["a", "b", "c"]);
  });

  it("still compares a plain array in order", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { tags: ["x", "y"] }))).toEqual(["a"]);
    expect(names(await queryItems(locator, { tags: ["y", "x"] }))).toEqual([]);
  });
});

describe("is_set — model upgrade", () => {
  /** The `item` schema with `colors` an enum array, then upgraded so that `colors` is a set. */
  async function upgradeToSet(locator: string) {
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, {
      kind: "update",
      schema: "schema",
      filters: { name: "item" },
      input: [itemDescription([{ name: "colors", type: "color", is_set: true }])],
    });
    return checkUpgrade(locator, upgradeLocator);
  }

  const ARRAY_PROPERTIES: TransientObject[] = [{ name: "colors", type: "color", is_array: true }];

  it("is incompatible when a stored value holds a duplicate", async () => {
    const { locator } = await setup(ARRAY_PROPERTIES);
    await createItem(locator, { name: "a", colors: ["red", "red"] });
    const check = await upgradeToSet(locator);
    expect(check.modifiedSchema.length).toBeGreaterThan(0);
  });

  it("is compatible when every stored value is free of duplicates, whatever its order", async () => {
    const { locator } = await setup(ARRAY_PROPERTIES);
    await createItem(locator, { name: "a", colors: ["blue", "red"] });
    const check = await upgradeToSet(locator);
    expect(check.modifiedSchema).toEqual([]);
  });
});

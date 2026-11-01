import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { checkUpgrade, createUpgradeLocator, registerPersistentFormat, runCommand } from "../src/index.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedScalarType, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * The `is_unique` property constraint — part `property_constraints` (*Unique
 * arrays*) of the document `model` in the `core` dataset.
 *
 * Declaration tests call schema processing directly. The others run through the
 * public API against a small in-memory transactional format, on an `item`
 * schema holding unique arrays of strings and integers, a plain `plain` array
 * and a set of the enum scalar type `color`.
 */

const color: NormalizedScalarType = { name: "color", extends: "string", constraints: { enum: ["red", "green", "blue"] } };

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

describe("is_unique — declaration", () => {
  it("accepts it on a scalar property without enum, and the processed property is also an array", () => {
    const schema = processSchemaDescription({ name: "item", properties: [{ name: "tags", type: "string", is_unique: true }] }, ctxWith());
    const prop = schema.properties.find((p) => p.name === "tags");
    expect(prop?.constraints.is_unique).toBe(true);
    expect(prop?.constraints.is_array).toBe(true);
  });

  it("accepts it together with is_array and with the [type] notation", () => {
    const schema = processSchemaDescription(
      {
        name: "item",
        properties: [
          { name: "both", type: "string", is_array: true, is_unique: true },
          { name: "bracketed", type: "[integer]", is_unique: true },
        ],
      },
      ctxWith(),
    );
    expect(schema.properties.map((p) => [p.constraints.is_unique, p.constraints.is_array])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("does not make a property an array when is_unique is false", () => {
    const schema = processSchemaDescription({ name: "item", properties: [{ name: "one", type: "string", is_unique: false }] }, ctxWith());
    expect(schema.properties.find((p) => p.name === "one")?.constraints.is_array).not.toBe(true);
  });

  it("rejects it on a relation with constraint_violation", () => {
    const bucket: NormalizedSchema = { name: "bucket", description: "", content: "", extends: null, cannot_be_extended: false, properties: [], constraints: {} };
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "item", properties: [{ name: "bucket", type: "bucket", is_unique: true }] }, ctxWith({ bucket })),
    );
  });

  it("rejects it on a map with constraint_violation", () => {
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "item", properties: [{ name: "names", type: "{string: string}", is_unique: true }] }, ctxWith()),
    );
  });

  it("accepts it together with is_set", () => {
    const schema = processSchemaDescription({ name: "item", properties: [{ name: "colors", type: "color", is_set: true, is_unique: true }] }, ctxWith());
    expect(schema.properties.find((p) => p.name === "colors")?.constraints.is_array).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through the public API
// ---------------------------------------------------------------------------

let formatCounter = 0;

function fakeFormat(): PersistenceInterface {
  const name = `test-unique-fmt-${++formatCounter}`;
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

const itemDescription = (properties: TransientObject[]): TransientObject => ({
  name: "item",
  shared_by_name: true,
  properties: [{ name: "name", type: "identifier" }, ...properties],
});

const UNIQUE_PROPERTIES: TransientObject[] = [
  { name: "tags", type: "string", is_unique: true },
  { name: "codes", type: "integer", is_unique: true },
  { name: "pair", type: "string", is_unique: true, max_length: 2 },
  { name: "plain", type: "string", is_array: true },
];

/** A fresh dataset holding the scalar type `color` and the `item` schema, seeded directly into the store. */
async function setup(itemProperties: TransientObject[] = UNIQUE_PROPERTIES): Promise<{ impl: PersistenceInterface; locator: string }> {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  await impl.putInstance("d1", "scalar_type", "color", color as unknown as TransientValue, {});
  const item = processSchemaDescription(itemDescription(itemProperties), ctxWith());
  await impl.putInstance("d1", "schema", "item", item as unknown as TransientValue, {});
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

describe("is_unique — writes", () => {
  it("defaults to the empty array", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a" });
    expect(await valueOf(locator, "a", "tags")).toEqual([]);
  });

  it("stores the entries in the order given", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", tags: ["north", "dock", "key"], codes: [3, 1, 2] });
    expect(await valueOf(locator, "a", "tags")).toEqual(["north", "dock", "key"]);
    expect(await valueOf(locator, "a", "codes")).toEqual([3, 1, 2]);
  });

  it("refuses a duplicate on create with constraint_violation", async () => {
    const { locator } = await setup();
    await expectConstraintViolationAsync(() => createItem(locator, { name: "a", tags: ["north", "dock", "north"] }));
    await expectConstraintViolationAsync(() => createItem(locator, { name: "b", codes: [1, 1] }));
    expect(names(await queryItems(locator))).toEqual([]);
  });

  it("refuses a duplicate on update with constraint_violation and leaves the stored value unchanged", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", tags: ["north"] });
    await expectConstraintViolationAsync(() => updateItem(locator, "a", { tags: ["dock", "key", "dock"] }));
    expect(await valueOf(locator, "a", "tags")).toEqual(["north"]);
  });

  it("compares entries as written, so a different case is a different entry", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", tags: ["North", "north"] });
    expect(await valueOf(locator, "a", "tags")).toEqual(["North", "north"]);
  });

  it("replaces the whole array on update, in the order given", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", tags: ["x", "y"] });
    const result = await updateItem(locator, "a", { tags: ["z", "x"] });
    expect((result.before[0] as TransientObject).tags).toEqual(["x", "y"]);
    expect((result.after[0] as TransientObject).tags).toEqual(["z", "x"]);
  });

  it("leaves a plain array free of the rule", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", plain: ["y", "x", "y"] });
    expect(await valueOf(locator, "a", "plain")).toEqual(["y", "x", "y"]);
  });

  it("counts entries for max_length", async () => {
    const { locator } = await setup();
    await createItem(locator, { name: "a", pair: ["x", "y"] });
    await expectConstraintViolationAsync(() => createItem(locator, { name: "b", pair: ["x", "y", "z"] }));
  });
});

describe("is_unique — together with is_set", () => {
  it("behaves as a set: canonical order and no duplicate", async () => {
    const { locator } = await setup([{ name: "colors", type: "color", is_set: true, is_unique: true }]);
    await createItem(locator, { name: "a", colors: ["blue", "red"] });
    expect(await valueOf(locator, "a", "colors")).toEqual(["red", "blue"]);
    await expectConstraintViolationAsync(() => createItem(locator, { name: "b", colors: ["red", "red"] }));
  });
});

describe("is_unique — filters", () => {
  async function seeded() {
    const s = await setup();
    await createItem(s.locator, { name: "a", tags: ["x", "y"] }, { name: "b", tags: ["y", "x"] }, { name: "c" });
    return s;
  }

  it("compares the array in order, like any array", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { tags: ["x", "y"] }))).toEqual(["a"]);
    expect(names(await queryItems(locator, { tags: ["y", "x"] }))).toEqual(["b"]);
  });

  it("keeps contains as on any array", async () => {
    const { locator } = await seeded();
    expect(names(await queryItems(locator, { tags: { contains: "x" } }))).toEqual(["a", "b"]);
  });
});

describe("is_unique — model upgrade", () => {
  /** The `item` schema with `tags` an array of strings, then upgraded so that `tags` is a unique array. */
  async function upgradeToUnique(locator: string) {
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, {
      kind: "update",
      schema: "schema",
      filters: { name: "item" },
      input: [itemDescription([{ name: "tags", type: "string", is_unique: true }])],
    });
    return checkUpgrade(locator, upgradeLocator);
  }

  const ARRAY_PROPERTIES: TransientObject[] = [{ name: "tags", type: "string", is_array: true }];

  it("is incompatible when a stored value holds a duplicate", async () => {
    const { locator } = await setup(ARRAY_PROPERTIES);
    await createItem(locator, { name: "a", tags: ["x", "x"] });
    const check = await upgradeToUnique(locator);
    expect(check.modifiedSchema.length).toBeGreaterThan(0);
  });

  it("is compatible when every stored value is free of duplicates", async () => {
    const { locator } = await setup(ARRAY_PROPERTIES);
    await createItem(locator, { name: "a", tags: ["y", "x"] });
    const check = await upgradeToUnique(locator);
    expect(check.modifiedSchema).toEqual([]);
  });
});

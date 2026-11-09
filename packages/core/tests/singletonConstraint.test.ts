import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { ModelError } from "../src/errors.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Resolvers } from "../src/resolvers.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * The `singleton` constraint on a user schema: a schema declaring it holds at
 * most one instance in the dataset, and a `create` of a second one fails with
 * `constraint_violation`. Same fakeImpl/resolvers harness as
 * command.inputWrapping.test.ts, since this is engine-level (command.ts).
 */

function fakeImpl(): PersistenceInterface {
  const dataset = {
    name: "test",
    model_major_version: 0,
    model_minor_version: 0,
    data_major_version: 0,
    data_minor_version: 0,
    created_at: "",
    updated_at: "",
  };
  const stores = new Map<string, Map<Key, TransientValue>>();

  function store(schema: string): Map<Key, TransientValue> {
    let s = stores.get(schema);
    if (!s) {
      s = new Map();
      stores.set(schema, s);
    }
    return s;
  }

  return {
    name: "fake",
    async datasetExists() {
      return true;
    },
    async createDataset() {
      return dataset as unknown as TransientValue;
    },
    async getDataset() {
      return dataset as unknown as TransientValue;
    },
    async updateDataset(_rest, patch) {
      Object.assign(dataset, patch as object);
      return dataset as unknown as TransientValue;
    },
    async deleteDataset() {},
    async getInstance(_rest, schema, key) {
      return store(schema).get(key) ?? null;
    },
    async listInstances(_rest, schema) {
      return [...store(schema).values()];
    },
    async putInstance(_rest, schema, key, instance) {
      store(schema).set(key, instance);
    },
    async deleteInstance(_rest, schema, key) {
      store(schema).delete(key);
    },
  };
}

/** A singleton `settings` and an ordinary `note`, both keyed by name. */
function resolvers(): Resolvers {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };

  for (const description of [
    {
      name: "settings",
      shared_by_name: true,
      is_root: true,
      singleton: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "title", type: "string" },
      ],
    },
    {
      name: "note",
      shared_by_name: true,
      is_root: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "title", type: "string" },
      ],
    },
  ]) {
    schemas.set(description.name, processSchemaDescription(description, ctx));
  }

  return { ctx, schemas, scalarTypes: new Map() };
}

async function expectConstraintViolation(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.fail("expected a constraint_violation");
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("constraint_violation");
  }
}

describe("singleton constraint on a user schema", () => {
  it("accepts the first instance", async () => {
    const result = await runCommand(
      fakeImpl(),
      "rest",
      { kind: "create", schema: "settings", input: [{ name: "main", title: "Main" }] },
      resolvers(),
    );

    expect(result.after).toEqual([{ name: "main", title: "Main" }]);
  });

  it("refuses a second instance created by a later command", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "settings", input: [{ name: "main", title: "Main" }] }, shared);

    await expectConstraintViolation(() =>
      runCommand(impl, "rest", { kind: "create", schema: "settings", input: [{ name: "other", title: "Other" }] }, shared),
    );

    const stored = await runCommand(impl, "rest", { kind: "query", schema: "settings" }, shared);
    expect(stored.after).toEqual([{ name: "main", title: "Main" }]);
  });

  it("refuses a second instance in the same input", async () => {
    await expectConstraintViolation(() =>
      runCommand(
        fakeImpl(),
        "rest",
        { kind: "create", schema: "settings", input: [{ name: "main", title: "Main" }, { name: "other", title: "Other" }] },
        resolvers(),
      ),
    );
  });

  it("accepts a new instance once the previous one is deleted", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "settings", input: [{ name: "main", title: "Main" }] }, shared);
    await runCommand(impl, "rest", { kind: "delete", schema: "settings", filters: { name: "main" } }, shared);

    const result = await runCommand(
      impl,
      "rest",
      { kind: "create", schema: "settings", input: [{ name: "other", title: "Other" }] },
      shared,
    );

    expect(result.after).toEqual([{ name: "other", title: "Other" }]);
  });

  it("leaves a schema without the constraint unrestricted", async () => {
    const impl = fakeImpl();
    const shared = resolvers();

    const result = await runCommand(
      impl,
      "rest",
      { kind: "create", schema: "note", input: [{ name: "one", title: "One" }, { name: "two", title: "Two" }] },
      shared,
    );

    expect(result.after).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { ModelError } from "../src/errors.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Resolvers } from "../src/resolvers.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * `input` shorthand for a single instance — packages/core/docs/spec/model-command-language.md#examples's
 * "A single instance shorthand" and the `Command.input` doc comment: a bare object is equivalent to a one-element array on
 * `create`/`update`/`delete`. Same fakeImpl/resolvers harness as
 * resultShaping.test.ts, since this is engine-level (command.ts) and needs no
 * persistent format.
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

/** A `note` keyed by name. */
function resolvers(): Resolvers {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };

  schemas.set(
    "note",
    processSchemaDescription(
      {
        name: "note",
        shared_by_name: true,
        properties: [
          { name: "name", type: "identifier" },
          { name: "title", type: "string" },
        ],
      },
      ctx,
    ),
  );

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

describe("input shorthand: a bare object stands for a one-element array", () => {
  it("wraps a bare object on create, same result as a one-element array", async () => {
    const impl = fakeImpl();
    const shared = resolvers();

    const result = await runCommand(
      impl,
      "rest",
      { kind: "create", schema: "note", input: { name: "one", title: "First" } as unknown as TransientValue[] },
      shared,
    );

    expect(result.after).toEqual([{ name: "one", title: "First" }]);
  });

  it("wraps a bare object on update, same result as a one-element array", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "note", input: [{ name: "one", title: "First" }] }, shared);

    const result = await runCommand(
      impl,
      "rest",
      {
        kind: "update",
        schema: "note",
        filters: { name: "one" },
        input: { title: "Renamed" } as unknown as TransientValue[],
      },
      shared,
    );

    expect(result.after).toEqual([{ name: "one", title: "Renamed" }]);
  });

  it("still throws constraint_violation for an input that isn't an array or an object", async () => {
    const impl = fakeImpl();
    const shared = resolvers();

    await expectConstraintViolation(() =>
      runCommand(
        impl,
        "rest",
        { kind: "create", schema: "note", input: "not an object" as unknown as TransientValue[] },
        shared,
      ),
    );
  });
});

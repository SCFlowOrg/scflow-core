import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { ModelError } from "../src/errors.js";
import { isUuid } from "../src/ids.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Resolvers } from "../src/resolvers.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * The `id` of an instance of a schema that is not `shared_by_name`: a `create`
 * generates a uuid, or keeps the canonical lowercase uuid the entry supplies and
 * refuses a malformed or already used one. Same fakeImpl/resolvers harness as
 * singletonConstraint.test.ts, since this is engine-level (command.ts, ids.ts).
 */

const UUID_A = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const UUID_B = "11111111-2222-4333-8444-555555555555";

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

/** An id-keyed `task` and a name-keyed `person`. */
function resolvers(): Resolvers {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };

  for (const description of [
    { name: "task", is_root: true, properties: [{ name: "title", type: "string" }] },
    {
      name: "person",
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

describe("id of a created instance", () => {
  it("generates a distinct canonical uuid for each entry without an id", async () => {
    const result = await runCommand(
      fakeImpl(),
      "rest",
      { kind: "create", schema: "task", input: [{ title: "One" }, { title: "Two" }] },
      resolvers(),
    );

    const ids = result.after.map((instance) => (instance as { id: unknown }).id);
    expect(ids.every((id) => isUuid(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("stores the instance under the generated id", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    const created = await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ title: "One" }] }, shared);
    const id = (created.after[0] as { id: string }).id;

    const found = await runCommand(impl, "rest", { kind: "query", schema: "task", filters: { id } }, shared);

    expect(found.after).toHaveLength(1);
  });

  it("keeps the id the entry supplies", async () => {
    const impl = fakeImpl();
    const shared = resolvers();

    const result = await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ id: UUID_A, title: "One" }] }, shared);

    expect((result.after[0] as { id: string }).id).toBe(UUID_A);
    const found = await runCommand(impl, "rest", { kind: "query", schema: "task", filters: { id: UUID_A } }, shared);
    expect(found.after).toHaveLength(1);
  });

  it("refuses an id already used by an instance of the schema", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ id: UUID_A, title: "One" }] }, shared);

    await expectConstraintViolation(() =>
      runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ id: UUID_A, title: "Two" }] }, shared),
    );

    const stored = await runCommand(impl, "rest", { kind: "query", schema: "task" }, shared);
    expect(stored.after).toHaveLength(1);
  });

  it("refuses the same id twice in one input", async () => {
    await expectConstraintViolation(() =>
      runCommand(
        fakeImpl(),
        "rest",
        { kind: "create", schema: "task", input: [{ id: UUID_A, title: "One" }, { id: UUID_A, title: "Two" }] },
        resolvers(),
      ),
    );
  });

  it("accepts the id of a deleted instance again", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ id: UUID_B, title: "One" }] }, shared);
    await runCommand(impl, "rest", { kind: "delete", schema: "task", filters: { id: UUID_B } }, shared);

    const result = await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ id: UUID_B, title: "Two" }] }, shared);

    expect((result.after[0] as { id: string }).id).toBe(UUID_B);
  });

  it.each([
    ["an uppercase uuid", UUID_A.toUpperCase()],
    ["a counter id", "task_1"],
    ["an empty string", ""],
    ["a uuid with a missing group", "6f1c2d3e-4a5b-4c6d-8e7f"],
    ["a number", 42],
  ])("refuses %s as an id", async (_label, id) => {
    await expectConstraintViolation(() =>
      runCommand(fakeImpl(), "rest", { kind: "create", schema: "task", input: [{ id, title: "One" }] }, resolvers()),
    );
  });

  it("refuses an id on a shared_by_name schema", async () => {
    await expectConstraintViolation(() =>
      runCommand(
        fakeImpl(),
        "rest",
        { kind: "create", schema: "person", input: [{ id: UUID_A, name: "ann", title: "Ann" }] },
        resolvers(),
      ),
    );
  });

  it("keeps a counter id readable and its instance updatable", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await impl.putInstance("rest", "task", "task_1", { id: "task_1", title: "Old" }, {});

    const result = await runCommand(
      impl,
      "rest",
      { kind: "update", schema: "task", filters: { id: "task_1" }, input: { title: "New" } },
      shared,
    );

    expect(result.after).toEqual([{ id: "task_1", title: "New" }]);
  });

  it("does not let an update change the id", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ id: UUID_A, title: "One" }] }, shared);

    await expectConstraintViolation(() =>
      runCommand(impl, "rest", { kind: "update", schema: "task", filters: { id: UUID_A }, input: { id: UUID_B } }, shared),
    );
  });
});

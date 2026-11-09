import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Resolvers } from "../src/resolvers.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * Verifies runCommand's engine actually threads propertyRoles through to the
 * PersistenceInterface — the mapping is derived once by Schema Processing and
 * handed down, per the `getInstance` doc comment of `PersistenceInterface`;
 * a format is never expected to derive it itself. This is
 * checked with a small recording fake implementation rather than a real
 * persistent format, since neither `js` nor `obsidian` needs to interpret
 * propertyRoles to be correct — only that the engine passes the right value.
 */

interface RecordedCall {
  method: "getInstance" | "listInstances" | "putInstance";
  schema: string;
  roles: Record<string, string>;
}

function fakeImpl(): { impl: PersistenceInterface; calls: RecordedCall[] } {
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
  const calls: RecordedCall[] = [];

  function store(schema: string): Map<Key, TransientValue> {
    let s = stores.get(schema);
    if (!s) {
      s = new Map();
      stores.set(schema, s);
    }
    return s;
  }

  const impl: PersistenceInterface = {
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
    async getInstance(_rest, schema, key, roles) {
      calls.push({ method: "getInstance", schema, roles });
      return store(schema).get(key) ?? null;
    },
    async listInstances(_rest, schema, roles) {
      calls.push({ method: "listInstances", schema, roles });
      return [...store(schema).values()];
    },
    async putInstance(_rest, schema, key, instance, roles) {
      calls.push({ method: "putInstance", schema, roles });
      store(schema).set(key, instance);
    },
    async deleteInstance(_rest, schema, key) {
      store(schema).delete(key);
    },
  };

  return { impl, calls };
}

function resolversFor(schemas: Map<string, NormalizedSchema>): Resolvers {
  const ctx: TypeResolutionContext = {
    resolveSchema: (name) => schemas.get(name),
    resolveScalarType: () => undefined,
  };
  return { ctx, schemas, scalarTypes: new Map() };
}

describe("runCommand — propertyRoles threading", () => {
  it("passes {} for a schema with no role-marked properties", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
    const task = processSchemaDescription({ name: "task", is_root: true, properties: [{ name: "title", type: "string" }] }, ctx);
    schemas.set("task", task);
    const resolvers = resolversFor(schemas);

    const { impl, calls } = fakeImpl();
    await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ title: "Ship it" }] }, resolvers);

    const taskCalls = calls.filter((c) => c.schema === "task");
    expect(taskCalls.length).toBeGreaterThan(0);
    for (const c of taskCalls) expect(c.roles).toEqual({});
  });

  it("passes the schema's own derived roles to putInstance on create and update", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
    const note = processSchemaDescription(
      { name: "note", is_root: true, properties: [{ name: "title", type: "string" }, { name: "body", type: "markdown", is_content: true }] },
      ctx,
    );
    schemas.set("note", note);
    const resolvers = resolversFor(schemas);

    const { impl, calls } = fakeImpl();
    const created = await runCommand(impl, "rest", { kind: "create", schema: "note", input: [{ title: "First", body: "hello" }] }, resolvers);
    const key = (created.after[0] as { id: string }).id;

    const putCallsCreate = calls.filter((c) => c.method === "putInstance" && c.schema === "note");
    expect(putCallsCreate.length).toBe(1);
    expect(putCallsCreate[0].roles).toEqual({ content: "body" });

    calls.length = 0;
    await runCommand(impl, "rest", { kind: "update", schema: "note", filters: { id: key }, input: [{ body: "updated" }] }, resolvers);
    const putCallsUpdate = calls.filter((c) => c.method === "putInstance" && c.schema === "note");
    expect(putCallsUpdate.length).toBe(1);
    expect(putCallsUpdate[0].roles).toEqual({ content: "body" });
  });

  it("uses the relation target's own roles when propagating an inverse change, not the source schema's", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };

    const person = processSchemaDescription(
      {
        name: "person",
        shared_by_name: true,
        properties: [{ name: "name", type: "identifier" }, { name: "bio", type: "markdown", is_content: true }],
      },
      ctx,
    );
    schemas.set("person", person);

    const task = processSchemaDescription(
      {
        name: "task",
        is_root: true,
        properties: [
          { name: "title", type: "string" },
          { name: "assignee", type: "person", inverse_name: "assigned_tasks", inverse_is_array: true },
        ],
      },
      ctx,
    );
    schemas.set("task", task);

    const resolvers = resolversFor(schemas);
    const { impl, calls } = fakeImpl();

    await runCommand(impl, "rest", { kind: "create", schema: "person", input: [{ name: "Alice", bio: "hi" }] }, resolvers);
    calls.length = 0; // only care about what task's create propagates onto person

    await runCommand(impl, "rest", { kind: "create", schema: "task", input: [{ title: "Do it", assignee: "Alice" }] }, resolvers);

    const personCalls = calls.filter((c) => c.schema === "person");
    expect(personCalls.length).toBeGreaterThan(0);
    for (const c of personCalls) expect(c.roles).toEqual({ content: "bio" });

    const taskCalls = calls.filter((c) => c.schema === "task");
    expect(taskCalls.length).toBeGreaterThan(0);
    for (const c of taskCalls) expect(c.roles).toEqual({}); // task itself has no role-marked properties
  });
});

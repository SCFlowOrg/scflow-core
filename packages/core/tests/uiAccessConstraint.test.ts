import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { ModelError } from "../src/errors.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Resolvers } from "../src/resolvers.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * The `ui_access` constraint on schemas and properties: which values schema
 * processing accepts, how it is inherited through `extends`, and that nothing
 * in command processing enforces it.
 */

const LEVELS = ["hidden", "read_only", "editable"] as const;

function ctxWith(schemas: Record<string, NormalizedSchema> = {}): TypeResolutionContext {
  return { resolveSchema: (name) => schemas[name], resolveScalarType: () => undefined };
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

describe("ui_access — values", () => {
  it.each(LEVELS)("a schema accepts %s", (level) => {
    const schema = processSchemaDescription(
      { name: "thing", is_root: true, ui_access: level, properties: [{ name: "title", type: "string" }] },
      ctxWith(),
    );
    expect(schema.constraints.ui_access).toBe(level);
  });

  it.each(LEVELS)("a property accepts %s", (level) => {
    const schema = processSchemaDescription(
      { name: "thing", is_root: true, properties: [{ name: "title", type: "string", ui_access: level }] },
      ctxWith(),
    );
    expect(schema.properties[0]!.constraints.ui_access).toBe(level);
  });

  it("a schema and a property without ui_access carry none", () => {
    const schema = processSchemaDescription(
      { name: "thing", is_root: true, properties: [{ name: "title", type: "string" }] },
      ctxWith(),
    );
    expect(schema.constraints.ui_access).toBeUndefined();
    expect(schema.properties[0]!.constraints.ui_access).toBeUndefined();
  });

  it.each([["an unknown string", "readonly"], ["a number", 3], ["a boolean", true], ["a bare key", null]])(
    "a schema rejects %s",
    (_label, value) => {
      expectConstraintViolation(() =>
        processSchemaDescription(
          { name: "thing", is_root: true, ui_access: value, properties: [{ name: "title", type: "string" }] },
          ctxWith(),
        ),
      );
    },
  );

  it.each([["an unknown string", "readonly"], ["a number", 3], ["a boolean", true], ["a bare key", null]])(
    "a property rejects %s",
    (_label, value) => {
      expectConstraintViolation(() =>
        processSchemaDescription(
          { name: "thing", is_root: true, properties: [{ name: "title", type: "string", ui_access: value }] },
          ctxWith(),
        ),
      );
    },
  );
});

describe("ui_access — inheritance through extends", () => {
  const base = processSchemaDescription(
    {
      name: "base",
      is_root: true,
      ui_access: "editable",
      properties: [{ name: "title", type: "string", ui_access: "hidden" }],
    },
    ctxWith(),
  );
  const ctx = ctxWith({ base });

  it("an extending schema takes the level of its parent", () => {
    const child = processSchemaDescription({ name: "child", extends: "base" }, ctx);
    expect(child.constraints.ui_access).toBe("editable");
  });

  it("an extending schema may state its own level", () => {
    const child = processSchemaDescription({ name: "child", extends: "base", ui_access: "read_only" }, ctx);
    expect(child.constraints.ui_access).toBe("read_only");
  });

  it("an overriding property keeps the inherited level unless it states one", () => {
    const kept = processSchemaDescription({ name: "kept", extends: "base", properties: [{ name: "title" }] }, ctx);
    expect(kept.properties.find((p) => p.name === "title")!.constraints.ui_access).toBe("hidden");

    const refined = processSchemaDescription(
      { name: "refined", extends: "base", properties: [{ name: "title", ui_access: "read_only" }] },
      ctx,
    );
    expect(refined.properties.find((p) => p.name === "title")!.constraints.ui_access).toBe("read_only");
  });
});

describe("ui_access — advisory", () => {
  it("an update of a property whose level is read_only succeeds", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const ticket = processSchemaDescription(
      { name: "ticket", is_root: true, ui_access: "read_only", properties: [{ name: "title", type: "string", ui_access: "read_only" }] },
      { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined },
    );
    schemas.set("ticket", ticket);
    const resolvers: Resolvers = {
      ctx: { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined },
      schemas,
      scalarTypes: new Map(),
    };

    const stores = new Map<string, Map<Key, TransientValue>>();
    const store = (schema: string): Map<Key, TransientValue> => {
      let s = stores.get(schema);
      if (!s) {
        s = new Map();
        stores.set(schema, s);
      }
      return s;
    };
    const dataset = {
      name: "test",
      model_major_version: 0,
      model_minor_version: 0,
      data_major_version: 0,
      data_minor_version: 0,
      created_at: "",
      updated_at: "",
    };
    const impl: PersistenceInterface = {
      name: "fake",
      areaOf: () => "",
      builtinRestFor: () => "no-builtin",
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

    const created = await runCommand(impl, "rest", { kind: "create", schema: "ticket", input: [{ title: "before" }] }, resolvers);
    const key = (created.after[0] as { id: string }).id;
    const updated = await runCommand(
      impl,
      "rest",
      { kind: "update", schema: "ticket", filters: { id: key }, input: [{ title: "after" }] },
      resolvers,
    );
    expect((updated.after[0] as { title: string }).title).toBe("after");
  });
});

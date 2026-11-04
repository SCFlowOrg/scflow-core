import { describe, expect, it } from "vitest";
import { resolveCommandForm, runCommand } from "../src/command.js";
import { ModelError } from "../src/errors.js";
import { runScript } from "../src/script.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Resolvers } from "../src/resolvers.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * Result shaping — packages/core/docs/spec/model-command-language.md#command's "Result shaping".
 * `result` narrows what a command returns without changing which instances it
 * acts on, so every test here pairs a shaped run with the assertion that the
 * stored data (or the unshaped buckets) is exactly what an unshaped run
 * produces. Engine-level, against the same recording fake implementation
 * propertyRoles.test.ts uses, since shaping happens in command.ts and needs no
 * persistent format to be exercised.
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
}

/** A `note` keyed by name, and a `task` keyed by a generated id. */
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
          { name: "content", type: "markdown" },
        ],
      },
      ctx,
    ),
  );

  schemas.set(
    "task",
    processSchemaDescription(
      { name: "task", is_root: true, properties: [{ name: "title", type: "string" }] },
      ctx,
    ),
  );

  return { ctx, schemas, scalarTypes: new Map() };
}

function expectResultOptionError(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected an unknown_result_option");
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("unknown_result_option");
  }
}

const NOTES = [
  { name: "one", title: "First", content: "a long body" },
  { name: "two", title: "Second", content: "another long body" },
];

describe("result shaping", () => {
  it("returns whole instances when `result` is absent", async () => {
    const impl = fakeImpl();
    const result = await runCommand(impl, "rest", { kind: "create", schema: "note", input: NOTES }, resolvers());

    expect(result.after).toEqual(NOTES);
    expect(result.before).toEqual([]);
  });

  it("defaults `before` to empty on a query, leaving `after` filled", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "note", input: NOTES }, shared);

    const result = await runCommand(impl, "rest", { kind: "query", schema: "note" }, shared);

    // A query's `before` and `after` are always identical copies of the same
    // selected instances, so the default omits `before` — filling it would
    // be pure duplication.
    expect(result.before).toEqual([]);
    expect(result["updated-before"]).toEqual([]);
    expect(result.after).toEqual(NOTES);
  });

  it("fills `before` on a query when `before: true` is requested explicitly", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "note", input: NOTES }, shared);

    const result = await runCommand(
      impl,
      "rest",
      { kind: "query", schema: "note", result: { before: true } },
      shared,
    );

    expect(result.before).toEqual(NOTES);
    expect(result.after).toEqual(NOTES);
  });

  it("keeps the key alone for an empty `properties`", async () => {
    const impl = fakeImpl();
    const result = await runCommand(
      impl,
      "rest",
      { kind: "create", schema: "note", input: NOTES, result: { properties: [] } },
      resolvers(),
    );

    expect(result.after).toEqual([{ name: "one" }, { name: "two" }]);
  });

  it("keeps the generated id for a schema not keyed by name", async () => {
    const impl = fakeImpl();
    const result = await runCommand(
      impl,
      "rest",
      { kind: "create", schema: "task", input: [{ title: "Ship it" }], result: { properties: [] } },
      resolvers(),
    );

    expect(result.after).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) }]);
  });

  it("keeps the key plus the named properties", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "note", input: NOTES }, shared);

    const result = await runCommand(
      impl,
      "rest",
      { kind: "query", schema: "note", result: { properties: ["title"] } },
      shared,
    );

    expect(result.after).toEqual([
      { name: "one", title: "First" },
      { name: "two", title: "Second" },
    ]);
  });

  it("shapes the result without changing what is stored", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(
      impl,
      "rest",
      { kind: "create", schema: "note", input: NOTES, result: { properties: [] } },
      shared,
    );

    const stored = await runCommand(impl, "rest", { kind: "query", schema: "note" }, shared);
    expect(stored.after).toEqual(NOTES);
  });

  it("empties `before` on `before: false`, leaving `after` untouched", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "note", input: NOTES }, shared);

    const result = await runCommand(
      impl,
      "rest",
      {
        kind: "update",
        schema: "note",
        filters: { name: "one" },
        input: [{ title: "Renamed" }],
        result: { before: false },
      },
      shared,
    );

    expect(result.before).toEqual([]);
    expect(result["updated-before"]).toEqual([]);
    expect(result.after).toEqual([{ name: "one", title: "Renamed", content: "a long body" }]);
  });

  it("still reports `before` on a delete when `before` is left alone", async () => {
    const impl = fakeImpl();
    const shared = resolvers();
    await runCommand(impl, "rest", { kind: "create", schema: "note", input: NOTES }, shared);

    const result = await runCommand(
      impl,
      "rest",
      { kind: "delete", schema: "note", filters: { name: "two" }, result: { properties: ["title"] } },
      shared,
    );

    expect(result.before).toEqual([{ name: "two", title: "Second" }]);
    expect(result.after).toEqual([]);
  });

  it("projects instances updated through an inverse relation", async () => {
    const schemas = new Map<string, NormalizedSchema>();
    const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
    schemas.set(
      "person",
      processSchemaDescription(
        {
          name: "person",
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }, { name: "bio", type: "markdown" }],
        },
        ctx,
      ),
    );
    schemas.set(
      "task",
      processSchemaDescription(
        {
          name: "task",
          is_root: true,
          properties: [
            { name: "title", type: "string" },
            { name: "assignee", type: "person", inverse_name: "assigned_tasks", inverse_is_array: true },
          ],
        },
        ctx,
      ),
    );
    const shared: Resolvers = { ctx, schemas, scalarTypes: new Map() };
    const impl = fakeImpl();

    await runCommand(impl, "rest", { kind: "create", schema: "person", input: [{ name: "Alice", bio: "a long bio" }] }, shared);
    const result = await runCommand(
      impl,
      "rest",
      {
        kind: "create",
        schema: "task",
        input: [{ title: "Do it", assignee: "Alice" }],
        result: { properties: [] },
      },
      shared,
    );

    expect(result.after).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) }]);
    // Alice comes back keyed only — `bio` and `assigned_tasks` are projected
    // away even though `person` is not the command's own schema.
    expect(result["updated-after"]).toEqual([{ name: "Alice" }]);
  });

  it("throws unknown_property for a name the schema does not declare", async () => {
    const impl = fakeImpl();
    try {
      await runCommand(impl, "rest", { kind: "query", schema: "note", result: { properties: ["titel"] } }, resolvers());
      expect.fail("expected an unknown_property");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe("unknown_property");
    }
  });

  it("throws unknown_result_option for an unrecognized option", () => {
    expectResultOptionError(() => resolveCommandForm({ query: "note", result: { propertys: [] } }));
  });

  it("throws unknown_result_option when `result` is not a mapping", () => {
    expectResultOptionError(() => resolveCommandForm({ query: "note", result: ["title"] }));
  });

  it("throws unknown_result_option for a mistyped option value", () => {
    expectResultOptionError(() => resolveCommandForm({ query: "note", result: { before: "no" } }));
  });

  it("shapes a script step the same way, `script_command` extending `command`", async () => {
    const impl = fakeImpl();
    const shared = resolvers();

    const result = await runScript(
      impl,
      "rest",
      {
        commands: [
          { kind: "create", schema: "note", input: [NOTES[0]], as: "first", result: { properties: ["title"] } },
          { kind: "create", schema: "note", input: [NOTES[1]], result: { properties: [] } },
        ],
      },
      async () => shared,
    );

    // The script's result is its last command's, shaped by that command.
    expect(result.after).toEqual([{ name: "two" }]);
  });

  it("carries a step's shaping into the result it names with `as`", async () => {
    const impl = fakeImpl();
    const shared = resolvers();

    const result = await runScript(
      impl,
      "rest",
      {
        commands: [
          { kind: "create", schema: "note", input: [NOTES[0]], as: "first", result: { properties: ["title"] } },
          {
            kind: "create",
            schema: "note",
            input: [{ name: "copy", title: "${first.after.0.title}", content: "-" }],
          },
        ],
      },
      async () => shared,
    );

    // `title` survived the first step's projection, so the placeholder in the
    // second step resolves to it.
    expect(result.after).toEqual([{ name: "copy", title: "First", content: "-" }]);
  });

  it("leaves `result` on the resolved command", () => {
    const resolved = resolveCommandForm({ query: "note", result: { properties: ["title"], before: false } });
    expect(resolved).toMatchObject({
      kind: "query",
      schema: "note",
      result: { properties: ["title"], before: false },
    });
  });
});

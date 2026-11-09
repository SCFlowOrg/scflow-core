import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { createApiSession, registerPersistentFormat, runCommand } from "../src/testing.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Text operations `append` and `replace` on an `update` — document part
 * `command` (*Text operations*, *Exceptions*) and `command_examples`
 * ("Update — text operations") in the `core` dataset, and the Text operations
 * section of `docs/commands.md`.
 *
 * Runs through the public API against a small in-memory transactional
 * format, on a `doc` schema carrying a `markdown` property, a `string`
 * property with a `pattern`, an `integer`, a `mandatory` `string` and a
 * `string` array.
 */

let formatCounter = 0;

function fakeFormat(): PersistenceInterface {
  const name = `test-textop-fmt-${++formatCounter}`;
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

/** A fresh dataset holding the `doc` schema, seeded directly into the store so no upgrade locator is needed. */
async function setup(): Promise<{ impl: PersistenceInterface; locator: string }> {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const doc = processSchemaDescription(
    {
      name: "doc",
      shared_by_name: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "body", type: "markdown" },
        { name: "code", type: "string", pattern: "^[A-Z-]*$" },
        { name: "count", type: "integer" },
        { name: "label", type: "string", mandatory: true },
        { name: "tags", type: "string", is_array: true },
      ],
    },
    ctx,
  );
  await impl.putInstance("d1", "schema", "doc", doc as unknown as TransientValue, {});
  return { impl, locator: `${impl.name}:d1` };
}

async function create(locator: string, ...docs: TransientObject[]): Promise<void> {
  await runCommand(locator, { kind: "create", schema: "doc", input: docs });
}

async function bodyOf(locator: string, name: string): Promise<TransientValue> {
  const result = await runCommand(locator, { kind: "query", schema: "doc", filters: { name } });
  return (result.after[0] as TransientObject).body;
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    expect.fail(`expected a ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe(code);
  }
}

const updateDoc = (name: string, patch: TransientObject) => ({ kind: "update" as const, schema: "doc", filters: { name }, input: [patch] });

describe("text operation: append", () => {
  it("adds to the end of the stored value, before and after carrying the old and the new value", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "Hello", label: "L" });

    const result = await runCommand(locator, updateDoc("a", { body: { append: ", world" } }));

    expect((result.before[0] as TransientObject).body).toBe("Hello");
    expect((result.after[0] as TransientObject).body).toBe("Hello, world");
    expect(await bodyOf(locator, "a")).toBe("Hello, world");
  });

  it("adds no separator of its own", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "line one\n", label: "L" });

    await runCommand(locator, updateDoc("a", { body: { append: "line two" } }));

    expect(await bodyOf(locator, "a")).toBe("line one\nline two");
  });

  it("gives the operand when the stored value is null", async () => {
    const { impl, locator } = await setup();
    await impl.putInstance("d1", "doc", "n", { name: "n", body: null, code: "", count: 0, label: "L", tags: [] }, {});

    const result = await runCommand(locator, updateDoc("n", { body: { append: "first" } }));

    expect((result.after[0] as TransientObject).body).toBe("first");
    expect(await bodyOf(locator, "n")).toBe("first");
  });
});

describe("text operation: replace", () => {
  it("swaps the single occurrence of find", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "Write the persistence interface", label: "L" });

    const result = await runCommand(locator, updateDoc("a", { body: { replace: { find: "interface", with: "interface contract" } } }));

    expect((result.before[0] as TransientObject).body).toBe("Write the persistence interface");
    expect((result.after[0] as TransientObject).body).toBe("Write the persistence interface contract");
    expect(await bodyOf(locator, "a")).toBe("Write the persistence interface contract");
  });

  it("deletes the occurrence when with is empty", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "keep DROP keep", label: "L" });

    await runCommand(locator, updateDoc("a", { body: { replace: { find: "DROP ", with: "" } } }));

    expect(await bodyOf(locator, "a")).toBe("keep keep");
  });

  it("matches literally and case-sensitively, without pattern syntax", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "a.c abc ABC", label: "L" });

    await runCommand(locator, updateDoc("a", { body: { replace: { find: "a.c", with: "X" } } }));
    expect(await bodyOf(locator, "a")).toBe("X abc ABC");

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { find: "aBc", with: "Y" } } })), "text_not_found");
  });

  it("refuses several occurrences with text_not_unique and writes nothing", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "one two one", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { find: "one", with: "1" } } })), "text_not_unique");

    expect(await bodyOf(locator, "a")).toBe("one two one");
  });

  it("replaces every occurrence with all: true", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "one two one", label: "L" });

    await runCommand(locator, updateDoc("a", { body: { replace: { find: "one", with: "1", all: true } } }));

    expect(await bodyOf(locator, "a")).toBe("1 two 1");
  });

  it("counts occurrences without overlap", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "aaa", label: "L" });

    // "aa" occurs once without overlap in "aaa", so the single-occurrence form applies.
    await runCommand(locator, updateDoc("a", { body: { replace: { find: "aa", with: "b" } } }));

    expect(await bodyOf(locator, "a")).toBe("ba");
  });

  it("refuses a find that occurs nowhere with text_not_found, with or without all", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "nothing here", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { find: "absent", with: "x" } } })), "text_not_found");
    await expectCode(
      () => runCommand(locator, updateDoc("a", { body: { replace: { find: "absent", with: "x", all: true } } })),
      "text_not_found",
    );
    expect(await bodyOf(locator, "a")).toBe("nothing here");
  });

  it("finds nothing in a null value", async () => {
    const { impl, locator } = await setup();
    await impl.putInstance("d1", "doc", "n", { name: "n", body: null, code: "", count: 0, label: "L", tags: [] }, {});

    await expectCode(() => runCommand(locator, updateDoc("n", { body: { replace: { find: "x", with: "y" } } })), "text_not_found");
  });
});

describe("text operation: malformed operations", () => {
  it("refuses an empty find with constraint_violation", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "text", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { find: "", with: "x" } } })), "constraint_violation");
  });

  it("refuses an append operand that is not a string", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "text", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { append: 5 } })), "constraint_violation");
  });

  it("refuses a replace without a string find or with, or with an all that is not a boolean", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "text", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { with: "x" } } })), "constraint_violation");
    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { find: "t" } } })), "constraint_violation");
    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: { find: 1, with: "x" } } })), "constraint_violation");
    await expectCode(
      () => runCommand(locator, updateDoc("a", { body: { replace: { find: "t", with: "x", all: "yes" } } })),
      "constraint_violation",
    );
    await expectCode(() => runCommand(locator, updateDoc("a", { body: { replace: "t" } })), "constraint_violation");
  });

  it("refuses a mapping with an unknown key, an empty mapping, and one with both keys, with unknown_text_operation", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "text", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { body: { prepend: "x" } })), "unknown_text_operation");
    await expectCode(() => runCommand(locator, updateDoc("a", { body: {} })), "unknown_text_operation");
    await expectCode(
      () => runCommand(locator, updateDoc("a", { body: { append: "x", replace: { find: "t", with: "u" } } })),
      "unknown_text_operation",
    );
    expect(await bodyOf(locator, "a")).toBe("text");
  });
});

describe("text operation: the result is validated as a literal would be", () => {
  it("refuses an append that breaks a pattern and leaves the stored value unchanged", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", code: "ABC", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { code: { append: "-1x" } })), "constraint_violation");

    const result = await runCommand(locator, { kind: "query", schema: "doc", filters: { name: "a" } });
    expect((result.after[0] as TransientObject).code).toBe("ABC");
  });

  it("accepts an append that keeps the pattern", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", code: "ABC", label: "L" });

    await runCommand(locator, updateDoc("a", { code: { append: "-DEF" } }));

    const result = await runCommand(locator, { kind: "query", schema: "doc", filters: { name: "a" } });
    expect((result.after[0] as TransientObject).code).toBe("ABC-DEF");
  });

  it("refuses a replace that breaks a pattern and leaves the stored value unchanged", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", code: "ABC", label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { code: { replace: { find: "B", with: "b" } } })), "constraint_violation");

    const result = await runCommand(locator, { kind: "query", schema: "doc", filters: { name: "a" } });
    expect((result.after[0] as TransientObject).code).toBe("ABC");
  });
});

describe("text operation: where it does not apply", () => {
  it("refuses an operation on an integer property", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", count: 3, label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { count: { append: "1" } })), "constraint_violation");
  });

  it("refuses an operation on an array property", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", tags: ["x"], label: "L" });

    await expectCode(() => runCommand(locator, updateDoc("a", { tags: { append: "y" } })), "constraint_violation");
  });

  it("refuses an operation inside a create", async () => {
    const { locator } = await setup();

    await expectCode(() => create(locator, { name: "a", body: { append: "x" }, label: "L" }), "constraint_violation");

    const result = await runCommand(locator, { kind: "query", schema: "doc" });
    expect(result.after).toHaveLength(0);
  });
});

describe("text operation: several matched instances", () => {
  it("applies the operation to each instance's own current value", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "alpha", label: "L" }, { name: "b", body: "beta", label: "L" });

    const result = await runCommand(locator, {
      kind: "update",
      schema: "doc",
      input: [{ body: { append: "!" } }],
    });

    expect(result.after.map((i) => (i as TransientObject).body)).toEqual(["alpha!", "beta!"]);
    expect(await bodyOf(locator, "a")).toBe("alpha!");
    expect(await bodyOf(locator, "b")).toBe("beta!");
  });

  it("cycles the operations over the matches like any patch", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "1", label: "L" }, { name: "b", body: "2", label: "L" }, { name: "c", body: "3", label: "L" });

    await runCommand(locator, {
      kind: "update",
      schema: "doc",
      input: [{ body: { append: "x" } }, { body: { append: "y" } }],
    });

    expect(await bodyOf(locator, "a")).toBe("1x");
    expect(await bodyOf(locator, "b")).toBe("2y");
    expect(await bodyOf(locator, "c")).toBe("3x");
  });

  // The update loop writes each instance before it processes the next, so a refusal on a later
  // instance leaves the earlier ones written. `it.fails` records that; it turns red once the loop
  // is atomic across the matched instances.
  it.fails("leaves the first instance as it was when a replace fails on the second", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "has token", label: "L" }, { name: "b", body: "has none", label: "L" });

    await expectCode(
      () =>
        runCommand(locator, {
          kind: "update",
          schema: "doc",
          input: [{ body: { replace: { find: "token", with: "TOKEN" } } }],
        }),
      "text_not_found",
    );

    expect(await bodyOf(locator, "a")).toBe("has token");
    expect(await bodyOf(locator, "b")).toBe("has none");
  });
});

describe("text operation: inside an ApiSession transaction", () => {
  it("reverting the delta restores the previous text and reverting its inverse applies the operation's result again", async () => {
    const { locator } = await setup();
    await create(locator, { name: "a", body: "Hello", label: "L" });
    const session = createApiSession();

    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, updateDoc("a", { body: { append: ", world" } }));
    const { delta } = await session.prepareTransaction(locator, tx);
    await session.commitTransaction(locator, tx);
    expect(await bodyOf(locator, "a")).toBe("Hello, world");

    const undoTx = await session.beginTransaction(locator);
    await session.revert(locator, delta);
    const inverse = await session.prepareTransaction(locator, undoTx);
    await session.commitTransaction(locator, undoTx);
    expect(await bodyOf(locator, "a")).toBe("Hello");

    const redoTx = await session.beginTransaction(locator);
    await session.revert(locator, inverse.delta);
    await session.commitTransaction(locator, redoTx);
    expect(await bodyOf(locator, "a")).toBe("Hello, world");
  });
});

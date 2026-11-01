import { describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";
import { applyInverseRelations } from "../src/modelUpgrade.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientValue } from "../src/types.js";

/**
 * Resolving a query's virtual (generated inverse) relation properties scans
 * the declaring family once per query, not once per candidate instance — see
 * LiveJoinCache's own comment in command.ts, "O(N x family size) for an
 * N-instance query". `fakeImpl` below counts calls to `listInstances` per
 * schema: the family a generated property is declared on is scanned exactly
 * once for the whole query, no matter how many candidate instances need that
 * property resolved.
 */

function ctxWith(schemas: Map<string, NormalizedSchema>): TypeResolutionContext {
  return {
    resolveSchema: (name) => schemas.get(name),
    resolveScalarType: () => undefined,
  };
}

function fakeImpl(): { impl: PersistenceInterface; listCalls: (schema: string) => number } {
  const stores = new Map<string, Map<Key, TransientValue>>();
  const listCounts = new Map<string, number>();

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
    areaOf: (rest) => rest,
    builtinRestFor: () => "no-builtin",
    datasetExists: async () => true,
    createDataset: async () => ({}),
    getDataset: async () => ({}),
    updateDataset: async (_rest, patch) => patch,
    deleteDataset: async () => {},
    async getInstance(_rest, schema, key) {
      return store(schema).get(key) ?? null;
    },
    async listInstances(_rest, schema) {
      listCounts.set(schema, (listCounts.get(schema) ?? 0) + 1);
      return [...store(schema).values()];
    },
    async putInstance(_rest, schema, key, instance) {
      store(schema).set(key, instance);
    },
    async deleteInstance(_rest, schema, key) {
      store(schema).delete(key);
    },
  };

  return { impl, listCalls: (schema: string) => listCounts.get(schema) ?? 0 };
}

describe("resolveVirtualProperties / liveInverseKeys — LiveJoinCache", () => {
  it("scans the declaring family once per query, not once per candidate instance", async () => {
    // box/item, per the `ownership` part: a direct
    // relation is always single-valued, so "a box owns several items" is
    // expressed by item's own `box` relation (owner + inverse_is_array),
    // not by a direct is_array+owns array on box. The generated virtual
    // property is therefore "items" on box, not "box" on item — so this
    // test queries "box" (N candidates) and checks "item" (the
    // declaring family) is scanned once for the whole query, not once per
    // box candidate.
    const schemas = new Map<string, NormalizedSchema>();
    const box = processSchemaDescription({ name: "box", properties: [] }, ctxWith(schemas));
    schemas.set("box", box);
    const item = processSchemaDescription(
      { name: "item", properties: [{ name: "box", type: "box", owner: true, inverse_is_array: true, inverse_name: "items" }] },
      ctxWith(schemas),
    );
    schemas.set("item", item);
    // A throwaway impl: applyInverseRelations only mutates `schemas` (adding
    // the generated `items` property onto `box`, and writing "schema"
    // storage on this impl) — it never touches the `item`/`box` data store
    // below.
    await applyInverseRelations(fakeImpl().impl, "test:rest", schemas, item);

    const { impl, listCalls } = fakeImpl();
    const N = 5;
    const boxKeys = Array.from({ length: N }, (_, i) => `box_${i}`);
    for (const key of boxKeys) {
      await impl.putInstance("test:rest", "box", key, { id: key }, {});
    }
    for (const key of boxKeys) {
      await impl.putInstance("test:rest", "item", `item_of_${key}`, { id: `item_of_${key}`, box: key }, {});
    }

    const resolvers = { ctx: ctxWith(schemas), schemas, scalarTypes: new Map() };
    const result = await runCommand(impl, "test:rest", { kind: "query", schema: "box" }, resolvers);

    expect(result.after).toHaveLength(N);
    for (const instance of result.after) {
      expect((instance as Record<string, unknown>).items).toHaveLength(1);
    }
    // The one assertion this test exists for: however many `box` candidates
    // the query resolves `items` for, `item` (the declaring family) is
    // scanned exactly once — not once per candidate (which would be N, i.e. 5
    // here).
    expect(listCalls("item")).toBe(1);
  });

  it("shares one scan across several virtual properties declared on the same family within one query", async () => {
    // `item` has two direct relations back onto itself (`before`/
    // `afterward`), each single-valued per the `relations` part
    // ("a directly declared relation is always single-valued") — mirrors
    // the `document_part` schema of dataset `core`, whose
    // satisfies/prerequisites/references each declare their own inverse
    // back on document_part itself. A query resolving both generated
    // (virtual, array-valued) inverse properties for every candidate must
    // still scan "item" only once per property — sharing LiveJoinCache
    // across properties too, not just across candidates.
    const schemas = new Map<string, NormalizedSchema>();
    const item = processSchemaDescription(
      {
        name: "item",
        properties: [
          { name: "before", type: "item", owner: true, inverse_name: "after_of", inverse_is_array: true },
          { name: "afterward", type: "item", owner: true, inverse_name: "before_of", inverse_is_array: true },
        ],
      },
      ctxWith(schemas),
    );
    schemas.set("item", item);
    await applyInverseRelations(fakeImpl().impl, "test:rest", schemas, item);

    const { impl, listCalls } = fakeImpl();
    const N = 4;
    const itemKeys = Array.from({ length: N }, (_, i) => `item_${i}`);
    for (let i = 0; i < N; i++) {
      const key = itemKeys[i];
      // Each item's single-valued `before`/`afterward` point at its
      // neighbors in a cycle, so every candidate's two generated properties
      // (after_of/before_of) each resolve to a non-trivial (length-1) set.
      const before = itemKeys[(i + 1) % N];
      const afterward = itemKeys[(i - 1 + N) % N];
      await impl.putInstance("test:rest", "item", key, { id: key, before, afterward }, {});
    }

    const resolvers = { ctx: ctxWith(schemas), schemas, scalarTypes: new Map() };
    const result = await runCommand(impl, "test:rest", { kind: "query", schema: "item" }, resolvers);

    expect(result.after).toHaveLength(N);
    // "item" is scanned 3 times total: once for the query's own ordinary
    // candidate fetch (unrelated to LiveJoinCache), plus once per distinct
    // generated property (after_of, before_of) the first candidate needs
    // resolved — each builds and caches its own reverse index the first time
    // it's needed, then every other candidate reads both from cache. Without
    // the cache it would be 1 + N x 2 (9, for N=4): a full rescan of "item"
    // per property per candidate.
    expect(listCalls("item")).toBe(3);
  });
});

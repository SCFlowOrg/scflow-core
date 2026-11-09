import { describe, expect, it } from "vitest";
import { modelError } from "../src/errors.js";
import { createEngine } from "../src/index.js";
import { queryDataset, registerPersistentFormat } from "../src/testing.js";
import type {
  Key,
  ObservableChange,
  PersistenceInterface,
  TransientObject,
  TransientValue,
} from "../src/types.js";

/**
 * `createEngine` (see `docs/formats.md`, Engines): an engine holds the formats
 * it is created with, and two engines share nothing.
 */

/** A minimal in-memory format named `name`. */
function memoryFormat(name: string): PersistenceInterface {
  const datasets = new Map<
    string,
    { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }
  >();
  const state = (rest: string) => {
    const found = datasets.get(rest);
    if (!found) throw modelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return found;
  };
  const store = (rest: string, schema: string) => {
    const stores = state(rest).stores;
    if (!stores.has(schema)) stores.set(schema, new Map());
    return stores.get(schema)!;
  };
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
      return state(rest).info;
    },
    async updateDataset(rest, patch) {
      return Object.assign(state(rest).info, patch as object);
    },
    async deleteDataset(rest) {
      state(rest);
      datasets.delete(rest);
    },
    async getInstance(rest, schema, key) {
      return store(rest, schema).get(key) ?? null;
    },
    async listInstances(rest, schema) {
      return [...store(rest, schema).values()];
    },
    async putInstance(rest, schema, key, instance) {
      store(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      store(rest, schema).delete(key);
    },
  };
}

describe("createEngine", () => {
  it("reaches the datasets of the formats it is given", async () => {
    const engine = createEngine({ formats: [memoryFormat("mem")] });
    await engine.initDataset("mem:plant", "plant");
    expect(await engine.queryDataset("mem:plant")).toMatchObject({ name: "plant" });
    expect(engine.formats.map((format) => format.name)).toEqual(["mem"]);
  });

  it("does not see the formats of the global registry, nor they its own", async () => {
    registerPersistentFormat(memoryFormat("engine-global"));
    const engine = createEngine({ formats: [memoryFormat("engine-own")] });
    await expect(engine.queryDataset("engine-global:x")).rejects.toMatchObject({
      code: "unknown_persistent_format",
    });
    await expect(queryDataset("engine-own:x")).rejects.toMatchObject({
      code: "unknown_persistent_format",
    });
  });

  it("shares nothing with another engine, formats of one name included", async () => {
    const one = createEngine({ formats: [memoryFormat("mem")] });
    const two = createEngine({ formats: [memoryFormat("mem")] });
    await one.initDataset("mem:plant", "plant");
    expect(await two.queryDataset("mem:plant")).toBeNull();
    await two.initDataset("mem:plant", "other");
    expect(await one.queryDataset("mem:plant")).toMatchObject({ name: "plant" });
  });

  it("keeps its observable listeners to itself", async () => {
    const one = createEngine({ formats: [memoryFormat("mem")] });
    const two = createEngine({ formats: [memoryFormat("mem")] });
    const seen: ObservableChange[] = [];
    one.subscribeObservable("mem:plant", (change) => seen.push(change));
    await two.initDataset("mem:plant", "plant");
    expect(seen).toEqual([]);
    await one.initDataset("mem:plant", "plant");
    expect(seen).toEqual([{ kind: "reset" }]);
  });

  it("runs commands and sessions on its own formats", async () => {
    const engine = createEngine({ formats: [memoryFormat("mem")] });
    await engine.initDataset("mem:plant", "plant");
    const session = engine.createActionSession();
    const tx = await session.beginTransaction("mem:plant", "rename");
    await session.runCommand("mem:plant", { update: "dataset", input: { name: "lyon" } });
    await session.commitTransaction("mem:plant", tx);
    expect(await engine.runCommand("mem:plant", { query: "dataset" })).toMatchObject({
      after: [{ name: "lyon" }],
    });
  });

  it("refuses two formats of one name", () => {
    expect(() => createEngine({ formats: [memoryFormat("mem"), memoryFormat("mem")] })).toThrow(
      expect.objectContaining({ code: "duplicate_name" }),
    );
  });
});

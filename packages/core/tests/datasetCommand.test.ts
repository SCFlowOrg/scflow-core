import { beforeAll, describe, expect, it } from "vitest";
import { createApiSession, deleteDataset, dumpDataset, initDataset, queryDataset, registerPersistentFormat, restoreDataset, runCommand } from "../src/testing.js";
import { ModelError } from "../src/errors.js";
import type { Key, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

let formatCounter = 0;

function fakeFormat(supportsTransactions = true): PersistenceInterface {
  const name = `test-dataset-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();

  function getState(rest: string) {
    const state = datasets.get(rest);
    if (!state) throw new Error(`no "${name}" dataset at "${rest}"`);
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
    supportsTransactions,

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
    async nextId(_rest, schema) {
      return `${schema}_1`;
    },
  };
}

let impl: PersistenceInterface;

beforeAll(() => {
  impl = fakeFormat(true);
  registerPersistentFormat(impl);
});

let locatorCounter = 0;

function nextLocator(): string {
  return `${impl.name}:dataset-cmd-${++locatorCounter}`;
}

describe("dataset as a command target", () => {
  it("query on dataset returns the dataset, equal to queryDataset", async () => {
    const locator = nextLocator();
    await initDataset(locator, "TestDataset");

    const queryResult = await runCommand(locator, {
      kind: "query",
      schema: "dataset",
    });

    const directQuery = await queryDataset(locator);

    expect(queryResult.after).toHaveLength(1);
    expect(queryResult.after[0]).toEqual(directQuery);

    await deleteDataset(locator);
  });

  it("queryDataset returns imports equal to [], and so does query on dataset", async () => {
    const locator = nextLocator();
    await initDataset(locator, "TestDataset");

    const direct = (await queryDataset(locator)) as any;
    expect(direct.imports).toEqual([]);

    const queryResult = await runCommand(locator, {
      kind: "query",
      schema: "dataset",
    });
    expect((queryResult.after[0] as any).imports).toEqual([]);

    await deleteDataset(locator);
  });

  it("query with a filter that does not match returns nothing", async () => {
    const locator = nextLocator();
    await initDataset(locator, "TestDataset");

    const queryResult = await runCommand(locator, {
      kind: "query",
      schema: "dataset",
      filters: { name: "NonExistent" },
    });

    expect(queryResult.after).toHaveLength(0);
    expect(queryResult.before).toHaveLength(0);

    await deleteDataset(locator);
  });

  it("update renames the dataset and bumps data_minor_version and updated_at", async () => {
    const locator = nextLocator();
    await initDataset(locator, "OldName");

    const before = (await queryDataset(locator)) as any;
    const initialDataMinor = before.data_minor_version;
    const initialUpdatedAt = before.updated_at;

    await new Promise(resolve => setTimeout(resolve, 10));

    const updateResult = await runCommand(locator, {
      kind: "update",
      schema: "dataset",
      input: [{ name: "NewName" }],
    });

    expect(updateResult.before).toHaveLength(1);
    expect((updateResult.before[0] as any).name).toBe("OldName");
    expect(updateResult.after).toHaveLength(1);
    expect((updateResult.after[0] as any).name).toBe("NewName");

    const after = (await queryDataset(locator)) as any;
    expect(after.name).toBe("NewName");
    expect(after.data_minor_version).toBe(initialDataMinor + 1);
    expect(after.updated_at >= initialUpdatedAt).toBe(true);

    await deleteDataset(locator);
  });

  it("rename to the same name changes nothing and bumps nothing", async () => {
    const locator = nextLocator();
    await initDataset(locator, "SameName");

    const before = (await queryDataset(locator)) as any;
    const initialDataMinor = before.data_minor_version;
    const initialUpdatedAt = before.updated_at;

    await runCommand(locator, {
      kind: "update",
      schema: "dataset",
      input: [{ name: "SameName" }],
    });

    const after = (await queryDataset(locator)) as any;
    expect(after.name).toBe("SameName");
    expect(after.data_minor_version).toBe(initialDataMinor);
    expect(after.updated_at).toBe(initialUpdatedAt);

    await deleteDataset(locator);
  });

  it("throws constraint_violation for a non-string name", async () => {
  const locator = nextLocator();
  await initDataset(locator, "TestDataset");

  for (const value of [42, null, true]) {
    try {
      await runCommand(locator, { kind: "update", schema: "dataset", input: [{ name: value }] });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe("constraint_violation");
    }
  }
});

  it("throws constraint_violation for each read-only property", async () => {
    const locator = nextLocator();
    await initDataset(locator, "TestDataset");

    const readOnlyProps = [
      "model_major_version",
      "model_minor_version",
      "data_major_version",
      "data_minor_version",
      "created_at",
      "updated_at",
      "schemas",
      "scalar_types",
    ];

    for (const prop of readOnlyProps) {
      try {
        await runCommand(locator, {
          kind: "update",
          schema: "dataset",
          input: [{ [prop]: "anything" }],
        });
        expect.fail(`should have thrown for property "${prop}"`);
      } catch (err) {
        expect(err).toBeInstanceOf(ModelError);
        expect((err as ModelError).code).toBe("constraint_violation");
      }
    }

    await deleteDataset(locator);
  });

  it("throws constraint_violation for create", async () => {
    const locator = nextLocator();
    await initDataset(locator, "TestDataset");

    try {
      await runCommand(locator, {
        kind: "create",
        schema: "dataset",
        input: [{ name: "NewDataset" }],
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe("constraint_violation");
    }

    await deleteDataset(locator);
  });

  it("throws constraint_violation for delete", async () => {
    const locator = nextLocator();
    await initDataset(locator, "TestDataset");

    try {
      await runCommand(locator, {
        kind: "delete",
        schema: "dataset",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe("constraint_violation");
    }

    await deleteDataset(locator);
  });

  it("inside an ApiSession transaction: commit then revert restores the name, reverting the inverse reapplies it", async () => {
    const locator = nextLocator();
    await initDataset(locator, "OriginalName");

    const session = createApiSession();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, {
      kind: "update",
      schema: "dataset",
      input: [{ name: "ChangedName" }],
    });
    const prepared = await session.prepareTransaction(locator, tx);
    await session.commitTransaction(locator, tx);

    expect(prepared.changed).toBe(true);

    let dataset = (await queryDataset(locator)) as any;
    expect(dataset.name).toBe("ChangedName");
    const dataMinorAfterCommit = dataset.data_minor_version;

    const undoTx = await session.beginTransaction(locator);
    await session.revert(locator, prepared.delta);
    const inverse = await session.prepareTransaction(locator, undoTx);
    await session.commitTransaction(locator, undoTx);

    dataset = (await queryDataset(locator)) as any;
    expect(dataset.name).toBe("OriginalName");
    expect(dataset.data_minor_version).toBeGreaterThan(dataMinorAfterCommit);

    expect(inverse.changed).toBe(true);

    const redoTx = await session.beginTransaction(locator);
    await session.revert(locator, inverse.delta);
    await session.commitTransaction(locator, redoTx);

    dataset = (await queryDataset(locator)) as any;
    expect(dataset.name).toBe("ChangedName");

    await deleteDataset(locator);
  });

  it("inside an ApiSession transaction: a rolled-back transaction leaves the name unchanged", async () => {
    const locator = nextLocator();
    await initDataset(locator, "OriginalName");

    const session = createApiSession();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, {
      kind: "update",
      schema: "dataset",
      input: [{ name: "ChangedName" }],
    });
    await session.rollbackTransaction(locator, tx);

    const dataset = (await queryDataset(locator)) as any;
    expect(dataset.name).toBe("OriginalName");
    expect(((await queryDataset(locator)) as any).data_minor_version).toBe(0);

    await deleteDataset(locator);
  });

  it("inside an ApiSession transaction: prepare reports the rename as a change", async () => {
    const locator = nextLocator();
    await initDataset(locator, "OriginalName");

    const session = createApiSession();
    
    expect(((await queryDataset(locator)) as any).data_minor_version).toBe(0);
    
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, {
      kind: "update",
      schema: "dataset",
      input: [{ name: "ChangedName" }],
    });
    const prepared = await session.prepareTransaction(locator, tx);
    await session.commitTransaction(locator, tx);

    expect(prepared.changed).toBe(true);

    await deleteDataset(locator);
  });

  it("dumpDataset then restoreDataset after a rename keeps the new name", async () => {
    const locator1 = nextLocator();
    const locator2 = nextLocator();
    
    await initDataset(locator1, "OriginalName");
    await runCommand(locator1, {
      kind: "update",
      schema: "dataset",
      input: [{ name: "RenamedDataset" }],
    });

    const dump = await dumpDataset(locator1, "json");
    await restoreDataset(locator2, dump, "json");

    const restored = (await queryDataset(locator2)) as any;
    expect(restored.name).toBe("RenamedDataset");

    await deleteDataset(locator1);
    await deleteDataset(locator2);
  });
});

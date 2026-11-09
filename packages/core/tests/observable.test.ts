import { describe, it, expect, beforeEach } from "vitest";
import { type ObservableChange } from "../src/api.js";
import { createApiSession, deleteDataset, dumpDataset, initDataset, registerPersistentFormat, restoreDataset, runCommand, subscribeObservable } from "../src/testing.js";
import { ModelError } from "../src/errors.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";
import type { ApiSession, Delta } from "../src/index.js";

const lastDeltas = new WeakMap<ApiSession, Delta>();

/** Reverts the delta last committed or reverted through `session`, in a transaction of its own, and keeps the inverse for the next call. */
async function revertLast(session: ApiSession, locator: string): Promise<void> {
  const tx = await session.beginTransaction(locator);
  await session.revert(locator, lastDeltas.get(session) as Delta);
  lastDeltas.set(session, (await session.prepareTransaction(locator, tx)).delta);
  await session.commitTransaction(locator, tx);
}

let formatCounter = 0;

function fakeFormat(): PersistenceInterface {
  const name = `test-obs-fmt-${++formatCounter}`;
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

  const persistenceImpl = {
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
    async nextId(rest, schema) {
      const store = getStore(rest, schema);
      return `${schema}_${store.size + 1}`;
    },
    async seedObservableTaskSchema(rest: string): Promise<void> {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
      const schema = processSchemaDescription(
        {
          name: "ObservableTask",
          observable: true,
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }],
        },
        ctx,
      );
      await persistenceImpl.putInstance(rest, "schema", "ObservableTask", schema as unknown as TransientValue, {});
    },
    async seedNonObservableNoteSchema(rest: string): Promise<void> {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
      const schema = processSchemaDescription(
        {
          name: "NonObservableNote",
          shared_by_name: true,
          properties: [{ name: "name", type: "identifier" }],
        },
        ctx,
      );
      await persistenceImpl.putInstance(rest, "schema", "NonObservableNote", schema as unknown as TransientValue, {});
    },
  };

  return persistenceImpl;
}

describe("T078b: observable schema constraint and subscribeObservable", () => {
  let impl: PersistenceInterface & {
    seedObservableTaskSchema: (rest: string) => Promise<void>;
    seedNonObservableNoteSchema: (rest: string) => Promise<void>;
  };
  let locator: string;

  beforeEach(async () => {
    impl = fakeFormat() as typeof impl;
    registerPersistentFormat(impl);
    locator = `${impl.name}:test-observable`;
    try {
      await deleteDataset(locator);
    } catch {
      // Dataset may not exist
    }
  });

  describe("observable constraint validation", () => {
    it("rejects a schema with both observable and embedded", async () => {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
      
      expect(() =>
        processSchemaDescription(
          {
            name: "BadSchema",
            observable: true,
            embedded: true,
            properties: [],
          },
          ctx,
        ),
      ).toThrow(/observable.*embedded/i);
    });

    it("accepts a schema with observable but not embedded", async () => {
      const schemas = new Map<string, NormalizedSchema>();
      const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
      
      const schema = processSchemaDescription(
        {
          name: "GoodSchema",
          observable: true,
          properties: [{ name: "name", type: "string" }],
        },
        ctx,
      );
      
      expect(schema.name).toBe("GoodSchema");
      expect(schema.constraints.observable).toBe(true);
    });
  });

  describe("delta notifications", () => {
    it("fires on outermost commitTransaction with correct filtering to observable schemas only", async () => {
      await initDataset(locator, "test");
      const rest = impl.areaOf("test-observable");
      
      // Seed two schemas: one observable, one not
      await impl.seedObservableTaskSchema(rest);
      await impl.seedNonObservableNoteSchema(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      const txId = await session.beginTransaction(locator);
      
      // Create instances of both schemas
      await session.runCommand(locator, {
        create: "ObservableTask",
        input: [{ name: "task1" }],
      });
      await session.runCommand(locator, {
        create: "NonObservableNote",
        input: [{ name: "note1" }],
      });
      
      lastDeltas.set(session, (await session.prepareTransaction(locator, txId)).delta);
      await session.commitTransaction(locator, txId);

      // Should have exactly one delta notification
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        // Should only include the observable schema
        expect(changes[0].changes).toHaveLength(1);
        expect(changes[0].changes[0].schema).toBe("ObservableTask");
        expect(changes[0].changes[0].key).toBe("task1");
        expect(changes[0].changes[0].before).toBeNull();
        expect(changes[0].changes[0].after).toMatchObject({ name: "task1" });
      }

      unsubscribe();
    });

    it("fires on a transaction made of a revert", async () => {
      await initDataset(locator, "test");
      const rest = impl.areaOf("test-observable");
      await impl.seedObservableTaskSchema(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      const txId = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "ObservableTask",
        input: [{ name: "task1" }],
      });
      lastDeltas.set(session, (await session.prepareTransaction(locator, txId)).delta);
      await session.commitTransaction(locator, txId);

      changes.length = 0; // Clear commit notification
      
      await revertLast(session, locator);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        expect(changes[0].changes).toHaveLength(1);
        expect(changes[0].changes[0].schema).toBe("ObservableTask");
        expect(changes[0].changes[0].before).toMatchObject({ name: "task1" });
        expect(changes[0].changes[0].after).toBeNull();
      }

      unsubscribe();
    });

    it("fires on the revert of a revert", async () => {
      await initDataset(locator, "test");
      const rest = impl.areaOf("test-observable");
      await impl.seedObservableTaskSchema(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      const txId = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "ObservableTask",
        input: [{ name: "task1" }],
      });
      lastDeltas.set(session, (await session.prepareTransaction(locator, txId)).delta);
      await session.commitTransaction(locator, txId);
      await revertLast(session, locator);

      changes.length = 0; // Clear previous notifications
      
      await revertLast(session, locator);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });
      
      if (changes[0].kind === "delta") {
        expect(changes[0].changes).toHaveLength(1);
        expect(changes[0].changes[0].schema).toBe("ObservableTask");
        expect(changes[0].changes[0].before).toBeNull();
        expect(changes[0].changes[0].after).toMatchObject({ name: "task1" });
      }

      unsubscribe();
    });

    it("does not fire for nested (non-outermost) commit", async () => {
      await initDataset(locator, "test");
      const rest = impl.areaOf("test-observable");
      await impl.seedObservableTaskSchema(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      const txId1 = await session.beginTransaction(locator);
      const txId2 = await session.beginTransaction(locator); // Nested
      
      await session.runCommand(locator, {
        create: "ObservableTask",
        input: [{ name: "task1" }],
      });
      
      await session.commitTransaction(locator, txId2); // Nested commit
      
      // No notification yet
      expect(changes).toHaveLength(0);
      
      await session.commitTransaction(locator, txId1); // Outermost commit
      
      // Now we get the notification
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "delta" });

      unsubscribe();
    });
  });

  describe("reset notifications", () => {
    it("fires on initDataset", async () => {
      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      await initDataset(locator, "test");

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ kind: "reset" });

      unsubscribe();
    });

    it("fires on restoreDataset", async () => {
      await initDataset(locator, "test");
      const dump = await dumpDataset(locator, "json");
      await deleteDataset(locator);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      await restoreDataset(locator, dump, "json");

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ kind: "reset" });

      unsubscribe();
    });

    it("fires on deleteDataset", async () => {
      await initDataset(locator, "test");

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      await deleteDataset(locator);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ kind: "reset" });

      unsubscribe();
    });
  });

  describe("listener lifecycle", () => {
    it("receives notifications when registered before dataset exists", async () => {
      // Delete any existing dataset
      try {
        await deleteDataset(locator);
      } catch {
        // May not exist
      }

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      // Now create the dataset
      await initDataset(locator, "test");

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ kind: "reset" });

      unsubscribe();
    });

    it("stops receiving notifications after unsubscribe", async () => {
      await initDataset(locator, "test");
      const rest = impl.areaOf("test-observable");
      await impl.seedObservableTaskSchema(rest);

      const changes: ObservableChange[] = [];
      const unsubscribe = subscribeObservable(locator, (change) => {
        changes.push(change);
      });

      const session = createApiSession();
      const txId1 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "ObservableTask",
        input: [{ name: "task1" }],
      });
      await session.commitTransaction(locator, txId1);

      expect(changes).toHaveLength(1);

      // Unsubscribe
      unsubscribe();
      changes.length = 0;

      // Make another change
      const txId2 = await session.beginTransaction(locator);
      await session.runCommand(locator, {
        create: "ObservableTask",
        input: [{ name: "task2" }],
      });
      await session.commitTransaction(locator, txId2);

      // Should not have received notification
      expect(changes).toHaveLength(0);
    });
  });
});

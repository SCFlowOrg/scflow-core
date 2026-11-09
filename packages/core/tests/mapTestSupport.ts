import { expect } from "vitest";
import { ModelError } from "../src/errors.js";
import { registerPersistentFormat, runCommand } from "../src/testing.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { Key, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * What the tests of the map types share: a small in-memory transactional
 * format, a dataset holding a `doc` schema whose properties each test
 * declares, and helpers to create, read and expect errors.
 */

let formatCounter = 0;

export function fakeFormat(): PersistenceInterface {
  const name = `test-maptypes-fmt-${++formatCounter}`;
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

/** A resolution context with no schema and no declared scalar type: only the built-ins resolve. */
export const noScalarTypes: TypeResolutionContext = { resolveSchema: () => undefined, resolveScalarType: () => undefined };

/** A fresh dataset holding a `doc` schema with the key `name` and the given properties. */
export async function setup(properties: TransientObject[]): Promise<{ locator: string }> {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  const doc = processSchemaDescription(
    { name: "doc", shared_by_name: true, properties: [{ name: "name", type: "identifier" }, ...properties] },
    noScalarTypes,
  );
  await impl.putInstance("d1", "schema", "doc", doc as unknown as TransientValue, {});
  return { locator: `${impl.name}:d1` };
}

export async function expectCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
    expect.fail(`expected a ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe(code);
  }
}

export const createDoc = (...inputs: TransientObject[]) => ({ kind: "create" as const, schema: "doc", input: inputs });

export const updateDoc = (name: string, patch: TransientObject) => ({
  kind: "update" as const,
  schema: "doc",
  filters: { name },
  input: [patch],
});

export async function propertyOf(locator: string, name: string, property: string): Promise<TransientValue> {
  const result = await runCommand(locator, { kind: "query", schema: "doc", filters: { name } });
  return (result.after[0] as TransientObject)[property];
}

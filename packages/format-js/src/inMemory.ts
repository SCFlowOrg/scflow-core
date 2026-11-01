import { modelError } from "@scfloworg/core";
import type { Key, PersistenceInterface, TransientValue } from "@scfloworg/core";

/**
 * The `js` format's in-memory core: dataset storage, the persistence
 * primitives and the `areaOf`/`builtinRestFor` pair. Internal to the package,
 * not a public entry point.
 *
 * This module imports nothing that touches the filesystem, so the browser
 * entry point can load it alone. The Node entry point adds the area's YAML
 * fallback through the `diskFallback` hook of `createJsPersistenceInterfaceCore`.
 */

/** A dataset's own properties: name, the four version numbers and the two timestamps. */
export interface DatasetRecord {
  name: string;
  model_major_version: number;
  model_minor_version: number;
  data_major_version: number;
  data_minor_version: number;
  created_at: string;
  updated_at: string;
  [key: string]: TransientValue;
}

/** One dataset's storage: its own properties and one `Map` per schema. */
export interface DatasetState {
  info: DatasetRecord;
  stores: Map<string, Map<Key, TransientValue>>;
}

/** Deep copy through a JSON round-trip, so no two callers share an object. */
export function cloneValue<T extends TransientValue>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The area of `rest`: the part before its last `/`, or `""` when `rest` has
 * no `/`. `rest` is `"<area>/<localRest>"`, and the area may itself contain
 * `/`. A pure string function with no I/O, identical on every entry point.
 */
export function areaOf(rest: string): string {
  const i = rest.lastIndexOf("/");
  return i === -1 ? "" : rest.slice(0, i);
}

/**
 * Builds a `js` `PersistenceInterface` over an in-memory dataset registry.
 *
 * Every read and write deep-copies through `cloneValue`, so callers may
 * mutate what they receive and two calls never return aliased objects.
 * It generates no id: the engine supplies every key. `lock` serializes the
 * callers of one `rest` in arrival order.
 * `getInstance` returns `null` for a missing key, while `deleteInstance`
 * throws `key_not_found`.
 *
 * `diskFallback`, when given, supplies the dataset of a `rest` that has no
 * in-memory dataset. The read primitives and the existence check of
 * `createDataset` consult it; `updateDataset`, `putInstance`,
 * `deleteInstance` and `deleteDataset` do not, so a dataset
 * resolved only through the fallback is read-only and those calls throw
 * `dataset_not_found` for it.
 *
 * `supportsTransactions` is `true`: only this process mutates an in-memory
 * dataset, so a captured delta can always be reverted or redone.
 *
 * @param name - the format prefix the interface answers to.
 * @param diskFallback - resolves a `rest` to a read-only dataset, or `null`
 * when nothing is there.
 * @throws `dataset_already_exists` from `createDataset` when `rest` resolves
 * to a dataset; `dataset_not_found` from any other dataset-level call on a
 * `rest` that does not.
 */
export function createJsPersistenceInterfaceCore(
  name: string,
  diskFallback?: (rest: string) => Promise<DatasetState | null>,
): PersistenceInterface {
  const datasets = new Map<string, DatasetState>();
  // The tail of each rest's lock chain: a caller waits for the tail it found,
  // then becomes the new tail. Removed once the last holder releases.
  const lockTails = new Map<string, Promise<void>>();

  function getState(rest: string): DatasetState {
    const state = datasets.get(rest);
    if (!state) throw modelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return state;
  }

  async function resolveState(rest: string): Promise<DatasetState | null> {
    const inMemory = datasets.get(rest);
    if (inMemory) return inMemory;
    return diskFallback ? diskFallback(rest) : null;
  }

  async function requireState(rest: string): Promise<DatasetState> {
    const state = await resolveState(rest);
    if (!state) throw modelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return state;
  }

  function getStore(state: DatasetState, schema: string): Map<Key, TransientValue> {
    let store = state.stores.get(schema);
    if (!store) {
      store = new Map();
      state.stores.set(schema, store);
    }
    return store;
  }

  function builtinRestFor(rest: string): string {
    return areaOf(rest);
  }

  return {
    name,
    areaOf,
    builtinRestFor,
    supportsTransactions: true,

    async datasetExists(rest) {
      return (await resolveState(rest)) !== null;
    },

    async createDataset(rest, dsName) {
      if (datasets.has(rest) || (diskFallback && (await diskFallback(rest)) !== null)) {
        throw modelError("dataset_already_exists", `a "${name}" dataset already exists at "${rest}"`);
      }
      const now = new Date().toISOString();
      const info: DatasetRecord = {
        name: dsName,
        model_major_version: 0,
        model_minor_version: 0,
        data_major_version: 0,
        data_minor_version: 0,
        created_at: now,
        updated_at: now,
      };
      datasets.set(rest, { info, stores: new Map() });
      return cloneValue(info as unknown as TransientValue);
    },

    async getDataset(rest) {
      return cloneValue((await requireState(rest)).info as unknown as TransientValue);
    },

    async updateDataset(rest, patch) {
      const state = getState(rest);
      Object.assign(state.info, patch as object);
      return cloneValue(state.info as unknown as TransientValue);
    },

    async deleteDataset(rest) {
      getState(rest); // throws dataset_not_found if missing
      datasets.delete(rest);
    },

    async getInstance(rest, schema, key) {
      const store = getStore(await requireState(rest), schema);
      const value = store.get(key);
      // `key_not_found` is not thrown by getInstance: the `PersistenceInterface`
      // signature returns `TransientValue | null`, so a missing key reads as null;
      // the more specific type wins
      // here, matching how filter.ts and command.ts use this call (a dangling
      // relation key should read as absent, not throw).
      return value === undefined ? null : cloneValue(value);
    },

    async listInstances(rest, schema) {
      const store = getStore(await requireState(rest), schema);
      return [...store.values()].map(cloneValue);
    },

    async putInstance(rest, schema, key, instance) {
      const store = getStore(getState(rest), schema);
      store.set(key, cloneValue(instance));
    },

    async deleteInstance(rest, schema, key) {
      const store = getStore(getState(rest), schema);
      if (!store.has(key)) {
        throw modelError("key_not_found", `no "${schema}" instance "${key}"`);
      }
      store.delete(key);
    },

    // One process holds every dataset of this format, so a promise queue per
    // `rest` is the whole mechanism. `release` is idempotent, so a caller that
    // releases twice cannot free the next holder's lock.
    async lock(rest) {
      const prior = lockTails.get(rest) ?? Promise.resolve();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const tail = prior.then(() => gate);
      lockTails.set(rest, tail);
      await prior;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (lockTails.get(rest) === tail) lockTails.delete(rest);
        open();
      };
    },
  };
}

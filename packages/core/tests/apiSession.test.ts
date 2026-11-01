import { describe, expect, it } from "vitest";
import { modelError } from "../src/errors.js";
import { createApiSession, createScriptSession, registerPersistentFormat, runCommand, runScript } from "../src/index.js";
import type { AuthoredCommand, Key, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Tests for ApiSession/createApiSession; `docs/sessions.md` states the contract.
 *
 * `fakeFormat` below is a minimal in-memory PersistenceInterface (in the
 * style of modelUpgrade.test.ts's `fakeImpl`), instrumented to count calls to
 * `listInstances(rest, "schema", ...)` per `rest`. That call is made exactly
 * once per `loadResolvers` (resolvers.ts) — the only place any of these
 * tests' schemas are loaded from — and no other code path here touches it:
 * every command run below targets `scalar_type` (a built-in META_SCHEMA,
 * needing no schema of its own to be defined first), never `schema` itself.
 * So the count is a direct, black-box proxy for "how many times was this
 * locator's Resolvers loaded" — the thing ApiSession's caching promise is
 * actually about.
 */

let formatCounter = 0;

function fakeFormat(): { impl: PersistenceInterface; schemaLoads: (rest: string) => number } {
  const name = `test-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();
  const schemaLoadCounts = new Map<string, number>();

  function getState(rest: string) {
    const state = datasets.get(rest);
    if (!state) throw modelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
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

  const impl: PersistenceInterface = {
    name,
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
      getState(rest); // throws dataset_not_found if missing
      datasets.delete(rest);
    },
    async getInstance(rest, schema, key) {
      const value = getStore(rest, schema).get(key);
      return value === undefined ? null : value;
    },
    async listInstances(rest, schema) {
      if (schema === "schema") {
        schemaLoadCounts.set(rest, (schemaLoadCounts.get(rest) ?? 0) + 1);
      }
      return [...getStore(rest, schema).values()];
    },
    async putInstance(rest, schema, key, instance) {
      getStore(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      getStore(rest, schema).delete(key);
    },
  };

  return { impl, schemaLoads: (rest: string) => schemaLoadCounts.get(rest) ?? 0 };
}

const query: AuthoredCommand = { kind: "query", schema: "scalar_type" };

describe("ApiSession", () => {
  it("loads a locator's Resolvers once and reuses them across runCommand calls", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    await session.runCommand(locator, query);
    await session.runCommand(locator, query);
    await session.runCommand(locator, query);

    expect(schemaLoads("d1")).toBe(1);
  });

  it("invalidate drops one locator's cached Resolvers, and only that one", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    await impl.createDataset("d2", "Other");
    const locator = `${impl.name}:d1`;
    const other = `${impl.name}:d2`;
    const session = createApiSession();

    await session.runCommand(locator, query);
    await session.runCommand(other, query);
    session.invalidate(locator);
    await session.runCommand(locator, query);
    await session.runCommand(other, query);

    expect(schemaLoads("d1")).toBe(2);
    expect(schemaLoads("d2")).toBe(1);
  });

  it("invalidate reaches a ScriptSession already open against the locator", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    const scriptSession = await session.createScriptSession(locator);
    await scriptSession.run(query);
    session.invalidate(locator);
    await scriptSession.run(query);

    expect(schemaLoads("d1")).toBe(2);
  });

  it("invalidate is a no-op for a locator this session never cached", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    session.invalidate(locator);
    await session.runCommand(locator, query);

    expect(schemaLoads("d1")).toBe(1);
  });

  it("shares the cache across runCommand, runScript and createScriptSession on the same locator", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    await session.runCommand(locator, query);
    await session.runScript(locator, { commands: [query] });
    const scriptSession = await session.createScriptSession(locator);
    await scriptSession.run(query);
    await scriptSession.run(query);
    await session.runCommand(locator, query);

    expect(schemaLoads("d1")).toBe(1);
  });

  it("shares the cache with a runCommand call made between two run() calls of the same ScriptSession", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    const scriptSession = await session.createScriptSession(locator);
    await scriptSession.run(query);
    await session.runCommand(locator, query);
    await scriptSession.run(query);

    expect(schemaLoads("d1")).toBe(1);
  });

  it("a second ScriptSession opened later against the same locator reuses the cached Resolvers", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    const first = await session.createScriptSession(locator);
    await first.run(query);
    const second = await session.createScriptSession(locator);
    await second.run(query);

    expect(schemaLoads("d1")).toBe(1);
  });

  it("caches independently per locator", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    await impl.createDataset("d2", "Test 2");
    const session = createApiSession();

    await session.runCommand(`${impl.name}:d1`, query);
    await session.runCommand(`${impl.name}:d1`, query);
    await session.runCommand(`${impl.name}:d2`, query);

    expect(schemaLoads("d1")).toBe(1);
    expect(schemaLoads("d2")).toBe(1);
  });

  it("does not share its cache with a different ApiSession", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;

    const sessionA = createApiSession();
    const sessionB = createApiSession();
    await sessionA.runCommand(locator, query);
    await sessionB.runCommand(locator, query);

    expect(schemaLoads("d1")).toBe(2);
  });

  it("returns the same shape and results as the free functions", async () => {
    const { impl } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;
    const session = createApiSession();

    const direct = await runCommand(locator, query);
    const viaSession = await session.runCommand(locator, query);
    expect(viaSession).toEqual(direct);
  });
});

/**
 * Regression coverage for script.ts's switch from a frozen `Resolvers`
 * snapshot to a `getResolvers` lookup (needed so ApiSession.createScriptSession
 * can share its cache — see above): the plain, non-session free functions
 * must keep their original caching behavior unchanged.
 */
describe("plain runCommand/runScript/createScriptSession (no ApiSession)", () => {
  it("runCommand reloads Resolvers on every call", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;

    await runCommand(locator, query);
    await runCommand(locator, query);

    expect(schemaLoads("d1")).toBe(2);
  });

  it("runScript loads Resolvers once for the whole script, not once per command", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;

    await runScript(locator, { commands: [query, query, query] });

    expect(schemaLoads("d1")).toBe(1);
  });

  it("createScriptSession loads Resolvers once, reused by every run() call, never reloaded", async () => {
    const { impl, schemaLoads } = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const locator = `${impl.name}:d1`;

    const session = await createScriptSession(locator);
    await session.run(query);
    await session.run(query);
    await session.run(query);

    expect(schemaLoads("d1")).toBe(1);
  });
});
